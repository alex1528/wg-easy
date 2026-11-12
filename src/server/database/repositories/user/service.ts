import { eq, sql, and, ne, count } from 'drizzle-orm';
import { TOTP } from 'otpauth';

import { user } from './schema';
import type { UserAdminUpdateType, UserType } from './types';
import { client } from '../client/schema';

import { WG_ENV } from '#server/utils/config';
import type { OAUTH_PROVIDER } from '#server/utils/oauth';
import { hashPassword, isPasswordValid } from '#server/utils/password';
import type { ID } from '#server/utils/types';
import { roles, type Role } from '#shared/utils/permissions';
import { decideOidcRole, MAX_STORED_GROUPS } from '#server/utils/oidcRole';
import { UserAdminError, isActiveAdmin, removesActiveAdmin } from '#server/utils/userAdmin';
import type { DBType } from '#db/sqlite';

type TxType = Parameters<Parameters<DBType['transaction']>[0]>[0];

/** groups of an OIDC login, used to calculate the role */
export type OidcRoleInput = {
  /** null = groups claim missing */
  groups: string[] | null;
  /** effective admin groups, empty = role mapping disabled */
  adminGroups: string[];
};

export type RoleChange = {
  id: ID;
  username: string;
  from: Role;
  to: Role;
};

type LoginResult =
  | {
      success: true;
      user: UserType;
    }
  | {
      success: false;
      error:
        | 'INCORRECT_CREDENTIALS'
        | 'USER_DISABLED'
        | 'INVALID_TOTP_CODE'
        | 'UNEXPECTED_ERROR';
    }
  | {
      success: false;
      error: 'TOTP_REQUIRED';
      userId: ID;
    };

type LoginWithOAuthResult =
  | {
      success: true;
      user: UserType;
    }
  | {
      success: false;
      error:
        | 'USER_DISABLED'
        | 'USER_ALREADY_LINKED'
        | 'UNEXPECTED_ERROR'
        | 'AUTO_REGISTER_DISABLED';
    }
  | {
      success: false;
      error: 'TOTP_REQUIRED';
      userId: ID;
    };

function createPreparedStatement(db: DBType) {
  return {
    findAll: db.query.user.findMany().prepare(),
    findById: db.query.user
      .findFirst({ where: eq(user.id, sql.placeholder('id')) })
      .prepare(),
    findByUsername: db.query.user
      .findFirst({
        where: eq(user.username, sql.placeholder('username')),
      })
      .prepare(),
    update: db
      .update(user)
      .set({
        name: sql.placeholder('name') as never as string,
        email: sql.placeholder('email') as never as string,
      })
      .where(eq(user.id, sql.placeholder('id')))
      .prepare(),
    updateKey: db
      .update(user)
      .set({
        totpKey: sql.placeholder('key') as never as string,
        totpVerified: false,
      })
      .where(eq(user.id, sql.placeholder('id')))
      .prepare(),
  };
}

export class UserService {
  #db: DBType;
  #statements: ReturnType<typeof createPreparedStatement>;

  constructor(db: DBType) {
    this.#db = db;
    this.#statements = createPreparedStatement(db);
  }

  #createTotp(user: { username: string; totpKey: string }) {
    return new TOTP({
      issuer: 'wg-easy',
      label: user.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: user.totpKey,
    });
  }

  async getAll() {
    return this.#statements.findAll.execute();
  }

  async get(id: ID) {
    return this.#statements.findById.execute({ id });
  }

  /**
   * Find a user by its OIDC identity without side effects.
   * Matches by (provider='oidc', oauthId) first, then by email if verified.
   */
  async findOidcUser(
    oauthId: string,
    email?: string,
    emailVerified?: boolean
  ): Promise<UserType | undefined> {
    const userById = await this.#db.query.user
      .findFirst({
        where: and(eq(user.oauthProvider, 'oidc'), eq(user.oauthId, oauthId)),
      })
      .execute();

    if (userById) {
      return userById;
    }

    if (!email || !emailVerified) {
      return undefined;
    }

    return (
      (await this.#db.query.user
        .findFirst({ where: eq(user.email, email) })
        .execute()) ?? undefined
    );
  }

  async getByUsername(username: string) {
    return this.#statements.findByUsername.execute({ username });
  }

  async create(
    username: string,
    password: string,
    name?: string | null,
    role?: Role
  ) {
    const hash = await hashPassword(password);

    return this.#db.transaction(async (tx) => {
      const oldUser = await tx.query.user
        .findFirst({
          where: eq(user.username, username),
        })
        .execute();

      if (oldUser) {
        throw new Error('User already exists');
      }

      // the first admin is created by the setup (or INIT_USERNAME)
      const adminCount = await tx.$count(user, eq(user.role, roles.ADMIN));

      await tx.insert(user).values({
        password: hash,
        username,
        email: null,
        name: name || (adminCount === 0 ? 'Administrator' : username),
        role: role ?? (adminCount === 0 ? roles.ADMIN : roles.CLIENT),
        roleSource: 'manual',
        totpVerified: false,
        enabled: true,
      });
    });
  }

  async update(id: ID, name: string, email: string | null) {
    return this.#statements.update.execute({ id, name, email });
  }

  async updatePassword(
    id: ID,
    currentPassword: string | null,
    newPassword: string
  ) {
    const hash = await hashPassword(newPassword);

    return this.#db.transaction(async (tx) => {
      // get user again to avoid password changing while request
      const txUser = await tx.query.user
        .findFirst({ where: eq(user.id, id) })
        .execute();

      if (!txUser) {
        throw new Error('User not found');
      }

      // only check password if already set
      if (txUser.password !== null) {
        if (!currentPassword) {
          throw new Error('Invalid password');
        }

        const passwordValid = await isPasswordValid(
          currentPassword,
          txUser.password
        );

        if (!passwordValid) {
          throw new Error('Invalid password');
        }
      }

      await tx
        .update(user)
        .set({ password: hash })
        .where(eq(user.id, id))
        .execute();
    });
  }

  updateTotpKey(id: ID, key: string | null) {
    return this.#statements.updateKey.execute({ id, key });
  }

  login(username: string, password: string) {
    return this.#db.transaction(async (tx): Promise<LoginResult> => {
      const txUser = await tx.query.user
        .findFirst({ where: eq(user.username, username) })
        .execute();

      // always check to avoid timing attack
      const userHashPassword = txUser?.password ?? null;
      const passwordValid = await isPasswordValid(password, userHashPassword);

      if (!txUser || !passwordValid) {
        return { success: false, error: 'INCORRECT_CREDENTIALS' };
      }

      if (!txUser.enabled) {
        return { success: false, error: 'USER_DISABLED' };
      }

      if (txUser.totpVerified) {
        return {
          success: false,
          error: 'TOTP_REQUIRED',
          userId: txUser.id,
        };
      }

      return { success: true, user: txUser };
    });
  }

  verifyTotp(id: ID, code: string) {
    return this.#db.transaction(async (tx) => {
      const txUser = await tx.query.user
        .findFirst({ where: eq(user.id, id) })
        .execute();

      if (!txUser) {
        throw new Error('User not found');
      }

      if (txUser.totpVerified) {
        throw new Error('TOTP is already verified');
      }

      const totpKey = txUser.totpKey;
      if (!totpKey) {
        throw new Error('TOTP key is not set');
      }

      const totp = this.#createTotp({ username: txUser.username, totpKey });
      if (totp.validate({ token: code, window: 1 }) === null) {
        throw new Error('Invalid TOTP code');
      }

      await tx
        .update(user)
        .set({ totpVerified: true })
        .where(eq(user.id, id))
        .execute();
    });
  }

  deleteTotpKey(id: ID, currentPassword: string) {
    return this.#db.transaction(async (tx) => {
      const txUser = await tx.query.user
        .findFirst({ where: eq(user.id, id) })
        .execute();

      if (!txUser) {
        throw new Error('User not found');
      }

      const passwordValid = await isPasswordValid(
        currentPassword,
        txUser.password
      );

      if (!passwordValid) {
        throw new Error('Invalid password');
      }

      await tx
        .update(user)
        .set({ totpKey: null, totpVerified: false })
        .where(eq(user.id, id))
        .execute();
    });
  }

  async validateTotpCode(id: ID, code: string) {
    const txUser = await this.#db.query.user
      .findFirst({ where: eq(user.id, id) })
      .execute();

    if (!txUser || !txUser.totpVerified || !txUser.totpKey) {
      return 'INVALID_TOTP_CODE' as const;
    }

    const totp = this.#createTotp({
      username: txUser.username,
      totpKey: txUser.totpKey,
    });
    const isValid = totp.validate({ token: code, window: 1 }) !== null;

    if (!isValid) {
      return 'INVALID_TOTP_CODE' as const;
    }

    if (!txUser.enabled) {
      return 'USER_DISABLED' as const;
    }

    return 'success' as const;
  }

  /**
   * Login or register user with OAuth provider.
   * If user with the same email already exists, link account with OAuth provider.
   * Otherwise, create new user.
   *
   * With `roleInput` (OIDC) the role of OIDC managed users is recalculated
   * from their groups. New users are never admin unless they are member of
   * an admin group.
   */
  async loginWithOAuth(
    provider: OAUTH_PROVIDER,
    oauthId: string,
    username: string,
    email: string,
    name: string,
    roleInput?: OidcRoleInput
  ): Promise<LoginWithOAuthResult> {
    return this.#db.transaction(async (tx) => {
      const userById = await tx.query.user
        .findFirst({
          where: and(
            eq(user.oauthProvider, provider),
            eq(user.oauthId, oauthId)
          ),
        })
        .execute();

      if (userById) {
        if (!userById.enabled) {
          return { success: false, error: 'USER_DISABLED' };
        }
        const updated = roleInput
          ? await this.#applyOidcRole(tx, userById, roleInput)
          : userById;
        if (updated.totpVerified) {
          return {
            success: false,
            error: 'TOTP_REQUIRED',
            userId: updated.id,
          };
        }
        return { success: true, user: updated };
      }

      const userByEmail = await tx.query.user
        .findFirst({
          where: eq(user.email, email),
        })
        .execute();

      if (userByEmail) {
        if (!userByEmail.enabled) {
          return { success: false, error: 'USER_DISABLED' };
        }
        if (userByEmail.oauthProvider && userByEmail.oauthId) {
          return {
            success: false,
            error: 'USER_ALREADY_LINKED',
          };
        }

        await tx
          .update(user)
          .set({ oauthProvider: provider, oauthId: oauthId })
          .where(eq(user.id, userByEmail.id))
          .execute();

        // a linked local account keeps its (manual) role
        const linked = {
          ...userByEmail,
          oauthProvider: provider,
          oauthId: oauthId,
        };
        const updated = roleInput
          ? await this.#applyOidcRole(tx, linked, roleInput)
          : linked;

        if (updated.totpVerified) {
          return {
            success: false,
            error: 'TOTP_REQUIRED',
            userId: updated.id,
          };
        }

        return { success: true, user: updated };
      }

      if (!WG_ENV.OAUTH_AUTO_REGISTER) {
        return { success: false, error: 'AUTO_REGISTER_DISABLED' };
      }

      // new users are never admin unless they are member of an admin group
      let role: Role = roles.CLIENT;
      let roleSource: 'manual' | 'oidc' = 'manual';
      let oidcGroups: string[] | null = null;
      if (roleInput) {
        const decision = decideOidcRole({
          isNewUser: true,
          adminGroups: roleInput.adminGroups,
          groups: roleInput.groups,
        });
        role = decision.role;
        roleSource = decision.source;
        oidcGroups = roleInput.groups?.slice(0, MAX_STORED_GROUPS) ?? null;
      }

      // Create new user
      const newUsers = await tx
        .insert(user)
        .values({
          username,
          password: null,
          email,
          name,
          role,
          roleSource,
          oidcGroups,
          totpVerified: false,
          enabled: true,
          oauthProvider: provider,
          oauthId,
        })
        .returning();
      const newUser = newUsers[0];

      if (!newUser) {
        return { success: false as const, error: 'UNEXPECTED_ERROR' as const };
      }
      if (newUser.role === roles.ADMIN) {
        console.info(
          `User change: target=${newUser.id}(${JSON.stringify(newUser.username)}) by=oidc-sync created as ADMIN (admin group)`
        );
      }
      return { success: true as const, user: newUser };
    });
  }

  /**
   * Store the OIDC groups and recalculate the role of an existing user.
   * Never removes the last enabled admin.
   */
  async #applyOidcRole(tx: TxType, u: UserType, roleInput: OidcRoleInput) {
    const decision = decideOidcRole({
      isNewUser: false,
      currentRole: u.role,
      roleSource: u.roleSource,
      adminGroups: roleInput.adminGroups,
      groups: roleInput.groups,
    });

    let nextRole = decision.role;
    if (decision.reason === 'claim_missing') {
      console.warn(
        `OIDC: groups claim missing for user ${u.id} (${JSON.stringify(u.username)}), role not changed`
      );
    }

    if (
      removesActiveAdmin(u, { role: nextRole, enabled: u.enabled }) &&
      (await this.#countActiveAdmins(tx, u.id)) === 0
    ) {
      console.warn(
        `OIDC: not demoting user ${u.id} (${JSON.stringify(u.username)}): last enabled admin`
      );
      nextRole = u.role;
    }

    const patch: Partial<Pick<UserType, 'role' | 'oidcGroups'>> = {};
    if (nextRole !== u.role) {
      patch.role = nextRole;
    }
    if (roleInput.groups !== null) {
      patch.oidcGroups = roleInput.groups.slice(0, MAX_STORED_GROUPS);
    }

    if (Object.keys(patch).length === 0) {
      return u;
    }

    await tx.update(user).set(patch).where(eq(user.id, u.id)).execute();

    if (patch.role !== undefined) {
      console.info(
        `User change: target=${u.id}(${JSON.stringify(u.username)}) by=oidc-sync role=${u.role === roles.ADMIN ? 'ADMIN' : 'CLIENT'}->${nextRole === roles.ADMIN ? 'ADMIN' : 'CLIENT'} (${decision.reason})`
      );
    }

    return { ...u, ...patch };
  }

  /** enabled admins, optionally without one user */
  async #countActiveAdmins(tx: TxType, excludeId?: ID) {
    const conditions = [eq(user.role, roles.ADMIN), eq(user.enabled, true)];
    if (excludeId !== undefined) {
      conditions.push(ne(user.id, excludeId));
    }
    return tx.$count(user, and(...conditions));
  }

  /** called when a session is created */
  async recordLogin(id: ID) {
    await this.#db
      .update(user)
      .set({ lastLoginAt: sql`(CURRENT_TIMESTAMP)` })
      .where(eq(user.id, id))
      .execute();
  }

  /**
   * All users for the admin panel, without secrets
   */
  async listWithStats() {
    const [users, clientCounts] = await Promise.all([
      this.#db.query.user.findMany({ orderBy: (t, { asc }) => asc(t.id) }),
      this.#db
        .select({ userId: client.userId, count: count() })
        .from(client)
        .groupBy(client.userId),
    ]);
    const countByUser = new Map(clientCounts.map((c) => [c.userId, c.count]));

    return users.map((u) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      email: u.email,
      role: u.role,
      roleSource: u.roleSource,
      enabled: u.enabled,
      oauthProvider: u.oauthProvider,
      hasPassword: u.password !== null,
      totpVerified: u.totpVerified,
      oidcGroups: u.oidcGroups,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      clientCount: countByUser.get(u.id) ?? 0,
    }));
  }

  /**
   * Change role / role source / enabled state of another user.
   * @throws {UserAdminError}
   */
  async adminUpdate(
    actorId: ID,
    targetId: ID,
    change: UserAdminUpdateType,
    adminGroups: readonly string[]
  ) {
    return this.#db.transaction(async (tx) => {
      const target = await tx.query.user
        .findFirst({ where: eq(user.id, targetId) })
        .execute();

      if (!target) {
        throw new UserAdminError('NOT_FOUND');
      }
      // don't lock yourself out
      if (target.id === actorId) {
        throw new UserAdminError('SELF');
      }

      const next = {
        role: target.role,
        roleSource: target.roleSource,
        enabled: target.enabled,
      };

      switch (change.action) {
        case 'setRole':
          next.role = change.role === 'ADMIN' ? roles.ADMIN : roles.CLIENT;
          next.roleSource = 'manual';
          break;
        case 'followOidc': {
          if (target.oauthProvider !== 'oidc') {
            throw new UserAdminError('NOT_OIDC');
          }
          next.roleSource = 'oidc';
          // recalculate now from the last known groups (if any)
          const decision = decideOidcRole({
            isNewUser: false,
            currentRole: target.role,
            roleSource: 'oidc',
            adminGroups,
            groups: target.oidcGroups ?? null,
          });
          next.role = decision.role;
          break;
        }
        case 'setEnabled':
          next.enabled = change.enabled;
          break;
      }

      if (
        removesActiveAdmin(target, next) &&
        (await this.#countActiveAdmins(tx, target.id)) === 0
      ) {
        throw new UserAdminError('LAST_ADMIN');
      }

      await tx.update(user).set(next).where(eq(user.id, target.id)).execute();

      return { before: target, after: { ...target, ...next } };
    });
  }

  /**
   * Delete a user and all of their clients.
   * @throws {UserAdminError}
   */
  async adminDelete(actorId: ID, targetId: ID) {
    return this.#db.transaction(async (tx) => {
      const target = await tx.query.user
        .findFirst({ where: eq(user.id, targetId) })
        .execute();

      if (!target) {
        throw new UserAdminError('NOT_FOUND');
      }
      // don't lock yourself out
      if (target.id === actorId) {
        throw new UserAdminError('SELF');
      }
      if (
        isActiveAdmin(target) &&
        (await this.#countActiveAdmins(tx, target.id)) === 0
      ) {
        throw new UserAdminError('LAST_ADMIN');
      }

      // clients reference the user (onDelete: restrict) → remove them first
      const deletedClients = await tx
        .delete(client)
        .where(eq(client.userId, target.id))
        .returning({ id: client.id })
        .execute();

      await tx.delete(user).where(eq(user.id, targetId)).execute();

      console.info(
        `User change: target=${target.id}(${JSON.stringify(target.username)}) by=user=${actorId} deleted (clients=${deletedClients.length})`
      );

      return { deletedClients: deletedClients.length };
    });
  }

  /**
   * Recalculate the role of every OIDC managed user from the stored groups.
   * Never removes the last enabled admin.
   */
  async resyncOidcRoles(adminGroups: readonly string[]) {
    return this.#db.transaction(async (tx) => {
      const users = await tx.query.user
        .findMany({ orderBy: (t, { asc }) => asc(t.id) })
        .execute();
      let activeAdmins = users.filter(
        (u) => u.enabled && u.role === roles.ADMIN
      ).length;

      const changed: RoleChange[] = [];
      let skipped = 0;

      for (const u of users) {
        if (u.roleSource !== 'oidc' || u.oidcGroups === null) {
          continue;
        }
        const decision = decideOidcRole({
          isNewUser: false,
          currentRole: u.role,
          roleSource: 'oidc',
          adminGroups,
          groups: u.oidcGroups,
        });
        if (decision.role === u.role) {
          continue;
        }
        const demotesActive = removesActiveAdmin(u, {
          role: decision.role,
          enabled: u.enabled,
        });
        if (demotesActive && activeAdmins <= 1) {
          skipped++;
          continue;
        }

        await tx
          .update(user)
          .set({ role: decision.role })
          .where(eq(user.id, u.id))
          .execute();

        if (demotesActive) {
          activeAdmins--;
        } else if (u.enabled && decision.role === roles.ADMIN) {
          activeAdmins++;
        }
        changed.push({
          id: u.id,
          username: u.username,
          from: u.role,
          to: decision.role,
        });
      }

      return { changed, skipped };
    });
  }

  unlinkOauth(id: ID) {
    return this.#db.transaction(async (tx) => {
      const txUser = await tx.query.user
        .findFirst({ where: eq(user.id, id) })
        .execute();

      if (!txUser) {
        throw new Error('User not found');
      }

      // can't unlink if no way to log back in
      if (!txUser.password) {
        throw new Error('Password login not enabled');
      }

      await tx
        .update(user)
        .set({ oauthProvider: null, oauthId: null })
        .where(eq(user.id, id))
        .execute();
    });
  }

  async linkOauth(id: ID, provider: OAUTH_PROVIDER, oauthId: string) {
    return this.#db.transaction(async (tx) => {
      const txUser = await tx.query.user
        .findFirst({ where: eq(user.id, id) })
        .execute();

      if (!txUser) {
        throw new Error('User not found');
      }

      if (txUser.oauthProvider || txUser.oauthId) {
        throw new Error('User already linked with an OAuth provider');
      }

      const existingUser = await tx.query.user
        .findFirst({
          where: and(
            eq(user.oauthProvider, provider),
            eq(user.oauthId, oauthId)
          ),
        })
        .execute();

      if (existingUser) {
        throw new Error('OAuth account already linked with another user');
      }

      await tx
        .update(user)
        .set({ oauthProvider: provider, oauthId: oauthId })
        .where(eq(user.id, id))
        .execute();
    });
  }
}
