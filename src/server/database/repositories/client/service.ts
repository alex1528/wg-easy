import { eq, sql, or, like, and } from 'drizzle-orm';
import { containsCidr, parseCidr } from 'cidr-tools';

import { client } from './schema';
import type {
  ClientCreateFromExistingType,
  ClientCreateType,
  ClientQueryType,
  UpdateClientType,
} from './types';

import { WG_ENV } from '#server/utils/config';
import Database from '#server/utils/Database';
import { nextIP } from '#server/utils/ip';
import {
  connectClientName,
  pickConnectClient,
} from '#server/utils/connectClient';
import { ClientLimitReachedError } from '#server/utils/clientLimit';
import type { ID } from '#server/utils/types';
import { wg } from '#server/utils/wgHelper';
import type { DBType } from '#db/sqlite';
import { wgInterface, userConfig } from '#db/schema';

export class MaxClientsReachedError extends Error {
  constructor(cause: unknown) {
    super('Maximum number of clients reached', { cause });
  }
}

export class PublicKeyConflictError extends Error {
  constructor() {
    super('Public key already in use');
  }
}

function createPreparedStatement(db: DBType) {
  return {
    findAll: db.query.client
      .findMany({
        with: {
          oneTimeLink: true,
          // peers of disabled users are not added to the server config
          user: { columns: { enabled: true } },
        },
      })
      .prepare(),
    findById: db.query.client
      .findFirst({ where: eq(client.id, sql.placeholder('id')) })
      .prepare(),
    findByIdPublic: db.query.client
      .findFirst({
        where: eq(client.id, sql.placeholder('id')),
        columns: {
          privateKey: false,
          preSharedKey: false,
        },
      })
      .prepare(),
    findByDevice: db.query.client
      .findFirst({
        where: and(
          eq(client.userId, sql.placeholder('userId') as never as number),
          eq(client.deviceId, sql.placeholder('deviceId') as never as string)
        ),
      })
      .prepare(),
    findByPublicKeyForUser: db.query.client
      .findFirst({
        where: and(
          eq(client.userId, sql.placeholder('userId') as never as number),
          eq(client.publicKey, sql.placeholder('publicKey') as never as string)
        ),
      })
      .prepare(),
    updateDeviceId: db
      .update(client)
      .set({ deviceId: sql.placeholder('deviceId') as never as string })
      .where(eq(client.id, sql.placeholder('id')))
      .prepare(),
    toggle: db
      .update(client)
      .set({ enabled: sql.placeholder('enabled') as never as boolean })
      .where(eq(client.id, sql.placeholder('id')))
      .prepare(),
    delete: db
      .delete(client)
      .where(eq(client.id, sql.placeholder('id')))
      .prepare(),
  };
}

export class ClientService {
  #db: DBType;
  #statements: ReturnType<typeof createPreparedStatement>;

  constructor(db: DBType) {
    this.#db = db;
    this.#statements = createPreparedStatement(db);
  }

  /**
   * Never return values directly from this function. Use {@link getAllPublic} instead.
   */
  async getAll() {
    const result = await this.#statements.findAll.execute();
    return result.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    }));
  }

  /**
   * Returns all clients without sensitive data
   */
  async getAllPublic({ filter, sort }: ClientQueryType) {
    const filters = [];

    if (filter?.trim()) {
      const filterPattern = `%${filter?.toLowerCase()}%`;
      filters.push(
        or(
          like(client.name, filterPattern),
          like(client.ipv4Address, filterPattern),
          like(client.ipv6Address, filterPattern)
        )
      );
    }

    const result = await this.#db.query.client
      .findMany({
        with: {
          oneTimeLink: true,
          user: { columns: { id: true, username: true, name: true } },
        },
        where: and(...filters),
        columns: {
          privateKey: false,
          preSharedKey: false,
        },
        orderBy: (t, { asc, desc }) => {
          if (sort === 'desc') {
            return desc(t.name);
          } else {
            // default to asc
            return asc(t.name);
          }
        },
      })
      .execute();

    return result.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    }));
  }

  /**
   * Returns all clients without sensitive data belonging to user
   */
  async getAllForUser(userId: ID, { filter, sort }: ClientQueryType) {
    const filters = [];

    if (filter?.trim()) {
      const filterPattern = `%${filter?.toLowerCase()}%`;
      filters.push(
        or(
          like(client.name, filterPattern),
          like(client.ipv4Address, filterPattern),
          like(client.ipv6Address, filterPattern)
        )
      );
    }

    const result = await this.#db.query.client
      .findMany({
        where: and(eq(client.userId, userId), ...filters),
        with: {
          oneTimeLink: true,
          user: { columns: { id: true, username: true, name: true } },
        },
        columns: {
          privateKey: false,
          preSharedKey: false,
        },
        orderBy: (t, { asc, desc }) => {
          if (sort === 'desc') {
            return desc(t.name);
          } else {
            // default to asc
            return asc(t.name);
          }
        },
      })
      .execute();

    return result.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    }));
  }

  /**
   * Includes WireGuard secrets. JSON API responses should use {@link getPublic}.
   */
  get(id: ID) {
    return this.#statements.findById.execute({ id });
  }

  /**
   * Returns one client without sensitive data
   */
  getPublic(id: ID) {
    return this.#statements.findByIdPublic.execute({ id });
  }

  /**
   * Create a client in the admin panel
   * @param userId owner of the client
   */
  async create({ name, expiresAt }: ClientCreateType, userId: ID) {
    return this.#db.transaction(async (tx) => {
      const clientId = await this.#insertWithKeys(tx, {
        userId,
        name,
        expiresAt,
        isDefault: false,
      });
      return [{ clientId }];
    });
  }

  /**
   * Generate a key pair, allocate the next free addresses and insert a client.
   * @throws {MaxClientsReachedError} if the address pool is exhausted
   */
  async #insertWithKeys(
    tx: Parameters<Parameters<DBType['transaction']>[0]>[0],
    input: {
      userId: ID;
      name: string;
      expiresAt: string | null;
      isDefault: boolean;
    }
  ): Promise<ID> {
    const privateKey = await wg.generatePrivateKey();
    const publicKey = await wg.getPublicKey(privateKey);
    const preSharedKey = await wg.generatePreSharedKey();

    const clients = await tx.query.client.findMany().execute();
    const clientInterface = await tx.query.wgInterface
      .findFirst({
        where: eq(wgInterface.name, WG_ENV.WG_INTERFACE),
      })
      .execute();

    if (!clientInterface) {
      throw new Error('WireGuard interface not found');
    }

    const clientConfig = await tx.query.userConfig
      .findFirst({
        where: eq(userConfig.id, clientInterface.name),
      })
      .execute();

    if (!clientConfig) {
      throw new Error('WireGuard interface configuration not found');
    }

    let ipv4Address: string;
    let ipv6Address: string;
    try {
      const ipv4Cidr = parseCidr(clientInterface.ipv4Cidr);
      ipv4Address = nextIP(4, ipv4Cidr, clients);
      const ipv6Cidr = parseCidr(clientInterface.ipv6Cidr);
      ipv6Address = nextIP(6, ipv6Cidr, clients);
    } catch (err) {
      throw new MaxClientsReachedError(err);
    }

    const result = await tx
      .insert(client)
      .values({
        name: input.name,
        userId: input.userId,
        interfaceId: WG_ENV.WG_INTERFACE,
        expiresAt: input.expiresAt,
        privateKey,
        publicKey,
        preSharedKey,
        ipv4Address,
        ipv6Address,
        mtu: clientConfig.defaultMtu,
        jC: clientConfig.defaultJC,
        jMin: clientConfig.defaultJMin,
        jMax: clientConfig.defaultJMax,
        i1: clientConfig.defaultI1,
        i2: clientConfig.defaultI2,
        i3: clientConfig.defaultI3,
        i4: clientConfig.defaultI4,
        i5: clientConfig.defaultI5,
        persistentKeepalive: clientConfig.defaultPersistentKeepalive,
        serverAllowedIps: [],
        isDefault: input.isDefault,
        enabled: true,
      })
      .returning({ clientId: client.id })
      .execute();

    const clientId = result[0]?.clientId;
    if (clientId === undefined) {
      throw new Error('Failed to create client');
    }
    return clientId;
  }

  /**
   * The client shown as the user's connect QR code:
   * the one marked as default, otherwise the oldest importable one.
   * Includes WireGuard secrets, never return it from an API directly.
   */
  async getConnectClient(userId: ID) {
    const clients = await this.#db.query.client
      .findMany({
        where: eq(client.userId, userId),
        columns: {
          id: true,
          name: true,
          enabled: true,
          deviceId: true,
          privateKey: true,
          isDefault: true,
        },
      })
      .execute();
    const picked = pickConnectClient(clients);
    if (!picked) {
      return null;
    }
    return {
      id: picked.id,
      name: picked.name,
      enabled: picked.enabled,
    };
  }

  /** number of clients of a user (enabled and disabled) */
  countForUser(userId: ID) {
    return this.#db.$count(client, eq(client.userId, userId));
  }

  /**
   * checked inside the creating transaction, so parallel requests can't
   * exceed the limit
   * @param limit null = unlimited
   * @throws {ClientLimitReachedError}
   */
  async #assertBelowLimit(
    tx: Parameters<Parameters<DBType['transaction']>[0]>[0],
    userId: ID,
    limit: number | null
  ) {
    if (limit === null) return;
    const count = await tx.$count(client, eq(client.userId, userId));
    if (count >= limit) {
      throw new ClientLimitReachedError(limit, count);
    }
  }

  /**
   * Create a new client for the user and make it the default connect client.
   * Older clients are kept.
   * @param limit max clients of the user, null = unlimited
   * @throws {MaxClientsReachedError}
   * @throws {ClientLimitReachedError}
   */
  async createConnectClient(
    user: { id: ID; username: string },
    limit: number | null = null
  ) {
    return this.#db.transaction(async (tx) => {
      await this.#assertBelowLimit(tx, user.id, limit);

      await tx
        .update(client)
        .set({ isDefault: false })
        .where(and(eq(client.userId, user.id), eq(client.isDefault, true)))
        .execute();

      const clientId = await this.#insertWithKeys(tx, {
        userId: user.id,
        name: connectClientName(user.username),
        expiresAt: null,
        isDefault: true,
      });
      return { clientId };
    });
  }

  /** the only field a non admin user can change */
  updateName(id: ID, name: string) {
    return this.#db
      .update(client)
      .set({ name })
      .where(eq(client.id, id))
      .execute();
  }

  toggle(id: ID, enabled: boolean) {
    return this.#statements.toggle.execute({ id, enabled });
  }

  delete(id: ID) {
    return this.#statements.delete.execute({ id });
  }

  /**
   * Find a client by its LiveWireGuard device id
   */
  async getByDevice(userId: ID, deviceId: string) {
    return await this.#statements.findByDevice.execute({
      userId,
      deviceId,
    });
  }

  /**
   * Find a client of a user by its public key
   */
  async getByPublicKeyForUser(userId: ID, publicKey: string) {
    return await this.#statements.findByPublicKeyForUser.execute({
      userId,
      publicKey,
    });
  }

  setDeviceId(id: ID, deviceId: string) {
    return this.#statements.updateDeviceId.execute({ id, deviceId });
  }

  /**
   * Create a client for a LiveWireGuard device.
   * The private key stays on the device, only its public key is stored.
   */
  async createForDevice(input: {
    userId: ID;
    deviceId: string;
    publicKey: string;
    name: string;
    /** max clients of the user, null / undefined = unlimited */
    limit?: number | null;
  }): Promise<{ clientId: ID }> {
    const preSharedKey = await wg.generatePreSharedKey();

    return this.#db.transaction(async (tx) => {
      await this.#assertBelowLimit(tx, input.userId, input.limit ?? null);

      const clients = await tx.query.client.findMany().execute();
      const clientInterface = await tx.query.wgInterface
        .findFirst({
          where: eq(wgInterface.name, WG_ENV.WG_INTERFACE),
        })
        .execute();

      if (!clientInterface) {
        throw new Error('WireGuard interface not found');
      }

      const clientConfig = await tx.query.userConfig
        .findFirst({
          where: eq(userConfig.id, clientInterface.name),
        })
        .execute();

      if (!clientConfig) {
        throw new Error('WireGuard interface configuration not found');
      }

      let ipv4Address: string;
      let ipv6Address: string;
      try {
        const ipv4Cidr = parseCidr(clientInterface.ipv4Cidr);
        ipv4Address = nextIP(4, ipv4Cidr, clients);
        const ipv6Cidr = parseCidr(clientInterface.ipv6Cidr);
        ipv6Address = nextIP(6, ipv6Cidr, clients);
      } catch (err) {
        throw new MaxClientsReachedError(err);
      }

      const result = await tx
        .insert(client)
        .values({
          name: input.name,
          userId: input.userId,
          interfaceId: WG_ENV.WG_INTERFACE,
          deviceId: input.deviceId,
          // the private key never leaves the device
          privateKey: '',
          publicKey: input.publicKey,
          preSharedKey,
          ipv4Address,
          ipv6Address,
          mtu: clientConfig.defaultMtu,
          jC: clientConfig.defaultJC,
          jMin: clientConfig.defaultJMin,
          jMax: clientConfig.defaultJMax,
          i1: clientConfig.defaultI1,
          i2: clientConfig.defaultI2,
          i3: clientConfig.defaultI3,
          i4: clientConfig.defaultI4,
          i5: clientConfig.defaultI5,
          persistentKeepalive: clientConfig.defaultPersistentKeepalive,
          serverAllowedIps: [],
          enabled: true,
        })
        .returning({ clientId: client.id })
        .execute();

      const clientId = result[0]?.clientId;

      if (clientId === undefined) {
        throw new Error('Failed to create client');
      }

      return { clientId };
    });
  }

  /**
   * Rotate the public key of a client (device regenerated its key pair)
   */
  async rotatePublicKey(id: ID, publicKey: string): Promise<'ok' | 'conflict'> {
    return this.#db.transaction(async (tx) => {
      const txClient = await tx.query.client
        .findFirst({ where: eq(client.id, id) })
        .execute();

      if (!txClient) {
        throw new Error('Client not found');
      }

      const conflict = await tx.query.client
        .findFirst({
          where: and(
            eq(client.publicKey, publicKey),
            eq(client.interfaceId, txClient.interfaceId)
          ),
        })
        .execute();

      if (conflict && conflict.id !== id) {
        return 'conflict';
      }

      await tx
        .update(client)
        .set({ publicKey })
        .where(eq(client.id, id))
        .execute();

      return 'ok';
    });
  }

  update(id: ID, data: UpdateClientType) {
    return this.#db.transaction(async (tx) => {
      const clientInterface = await tx.query.wgInterface
        .findFirst({
          where: eq(wgInterface.name, WG_ENV.WG_INTERFACE),
        })
        .execute();

      if (!clientInterface) {
        throw new Error('WireGuard interface not found');
      }

      if (!containsCidr(clientInterface.ipv4Cidr, data.ipv4Address)) {
        throw new Error('IPv4 address is not within the CIDR range');
      }

      if (!containsCidr(clientInterface.ipv6Cidr, data.ipv6Address)) {
        throw new Error('IPv6 address is not within the CIDR range');
      }

      await tx.update(client).set(data).where(eq(client.id, id)).execute();
    });
  }

  async createFromExisting({
    name,
    enabled,
    ipv4Address,
    ipv6Address,
    preSharedKey,
    privateKey,
    publicKey,
  }: ClientCreateFromExistingType) {
    const clientConfig = await Database.userConfigs.get();

    return this.#db
      .insert(client)
      .values({
        name,
        userId: 1,
        interfaceId: WG_ENV.WG_INTERFACE,
        privateKey,
        publicKey,
        preSharedKey,
        ipv4Address,
        ipv6Address,
        mtu: clientConfig.defaultMtu,
        jC: clientConfig.defaultJC,
        jMin: clientConfig.defaultJMin,
        jMax: clientConfig.defaultJMax,
        i1: clientConfig.defaultI1,
        i2: clientConfig.defaultI2,
        i3: clientConfig.defaultI3,
        i4: clientConfig.defaultI4,
        allowedIps: clientConfig.defaultAllowedIps,
        dns: clientConfig.defaultDns,
        persistentKeepalive: clientConfig.defaultPersistentKeepalive,
        serverAllowedIps: [],
        enabled,
      })
      .execute();
  }
}
