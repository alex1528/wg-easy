<template>
  <div
    class="flex flex-col gap-3 px-4 py-3"
    :class="{ 'opacity-60': !user.enabled }"
  >
    <div class="flex flex-col gap-3 md:flex-row md:items-center">
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <BaseAvatar class="h-9 w-9 shrink-0 text-sm">{{ initials }}</BaseAvatar>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-1 font-medium">
            <span class="truncate">{{ user.name }}</span>
            <span
              v-if="user.isSelf"
              class="rounded bg-blue-100 px-1.5 text-xs text-blue-800 dark:bg-blue-900 dark:text-blue-200"
            >
              {{ $t('admin.users.you') }}
            </span>
          </div>
          <div class="truncate text-xs text-gray-500 dark:text-neutral-400">
            @{{ user.username
            }}<template v-if="user.email"> · {{ user.email }}</template>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-1.5 text-xs md:w-56">
        <span
          class="rounded px-2 py-0.5 font-semibold"
          :class="
            user.role === 'ADMIN'
              ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
              : 'bg-gray-100 text-gray-700 dark:bg-neutral-600 dark:text-neutral-200'
          "
        >
          {{
            user.role === 'ADMIN' ? $t('user.roleAdmin') : $t('user.roleClient')
          }}
        </span>
        <span
          class="rounded border border-dashed border-gray-300 px-2 py-0.5 text-gray-500 dark:border-neutral-500 dark:text-neutral-400"
          :title="
            user.roleSource === 'oidc'
              ? $t('user.roleSourceOidcDesc')
              : $t('user.roleSourceManualDesc')
          "
        >
          {{
            user.roleSource === 'oidc'
              ? $t('user.roleSourceOidc')
              : $t('user.roleSourceManual')
          }}
        </span>
        <span
          v-if="user.oauthProvider"
          class="flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-gray-600 dark:bg-neutral-600 dark:text-neutral-300"
        >
          <IconsBrandsProvider :provider="user.oauthProvider" class="size-3" />
          {{ user.oauthProvider.toUpperCase() }}
        </span>
        <span
          v-if="user.hasPassword"
          class="rounded bg-gray-100 px-2 py-0.5 text-gray-600 dark:bg-neutral-600 dark:text-neutral-300"
        >
          {{ $t('admin.users.loginPassword') }}
        </span>
        <span
          v-if="user.totpVerified"
          class="rounded bg-gray-100 px-2 py-0.5 text-gray-600 dark:bg-neutral-600 dark:text-neutral-300"
          :title="$t('admin.users.loginTotp')"
        >
          2FA
        </span>
      </div>

      <div
        class="flex flex-col text-xs text-gray-500 md:w-44 dark:text-neutral-400"
      >
        <span>
          <span
            class="mr-1 inline-block size-2 rounded-full"
            :class="user.enabled ? 'bg-green-500' : 'bg-gray-400'"
          />
          {{
            user.enabled
              ? $t('admin.users.statusEnabled')
              : $t('admin.users.statusDisabled')
          }}
          ·
          <span
            :class="{
              'font-semibold text-amber-600 dark:text-amber-400': atLimit,
            }"
            :title="atLimit ? $t('admin.users.clientLimitReached') : undefined"
          >
            {{
              clientLimit === null
                ? $t('admin.users.clientCount', { count: user.clientCount })
                : $t('admin.users.clientCountLimit', {
                    count: user.clientCount,
                    max: clientLimit,
                  })
            }}
          </span>
        </span>
        <span>{{ lastLogin }}</span>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <template v-for="action in actions" :key="action.id">
        <AdminUserActionDialog
          v-if="!action.disabledReason"
          :action="action.id"
          :user="user"
          :admin-groups-configured="adminGroupsConfigured"
          @confirm="run(action.id)"
        >
          <BaseSecondaryButton as="span" class="px-3 py-1 text-xs">
            {{ action.label }}
          </BaseSecondaryButton>
        </AdminUserActionDialog>
        <span
          v-else
          class="inline-flex cursor-not-allowed items-center rounded border-2 border-gray-100 px-3 py-1 text-xs text-gray-400 dark:border-neutral-600 dark:text-neutral-500"
          :title="action.disabledReason"
        >
          {{ action.label }}
        </span>
      </template>
      <button
        v-if="user.oauthProvider === 'oidc'"
        type="button"
        class="ml-auto text-xs text-gray-500 underline hover:text-red-800 dark:text-neutral-400"
        @click="expanded = !expanded"
      >
        {{
          expanded ? $t('admin.users.hideGroups') : $t('admin.users.showGroups')
        }}
      </button>
    </div>

    <div
      v-if="expanded"
      class="rounded bg-gray-50 p-3 text-xs dark:bg-neutral-800"
    >
      <div class="mb-1 text-gray-500 dark:text-neutral-400">
        {{ $t('admin.users.groups') }}
      </div>
      <div v-if="user.oidcGroups && user.oidcGroups.length > 0">
        <span
          v-for="group in user.oidcGroups"
          :key="group"
          class="mb-1 mr-1 inline-block rounded px-1.5 py-0.5 font-mono"
          :class="
            user.matchedAdminGroups.includes(group)
              ? 'bg-green-100 font-semibold text-green-800 dark:bg-green-950 dark:text-green-300'
              : 'bg-gray-200 dark:bg-neutral-600'
          "
        >
          {{ group }}
        </span>
        <div class="mt-1">
          {{
            user.matchedAdminGroups.length > 0
              ? $t('admin.users.matched', {
                  groups: user.matchedAdminGroups.join(', '),
                })
              : $t('admin.users.notMatched')
          }}
        </div>
      </div>
      <div v-else>{{ $t('admin.users.noGroups') }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  user: AdminUser;
  activeAdmins: number;
  adminGroupsConfigured: boolean;
  /** 0 = unlimited */
  maxClients: number;
}>();

const emit = defineEmits<{ changed: [] }>();

const { t, locale } = useI18n();

const expanded = ref(false);

/** admins are not limited */
const clientLimit = computed(() =>
  props.user.role === 'ADMIN' || props.maxClients <= 0
    ? null
    : props.maxClients
);
const atLimit = computed(
  () => clientLimit.value !== null && props.user.clientCount >= clientLimit.value
);

const initials = computed(() =>
  (props.user.name || props.user.username)
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase())
    .slice(0, 2)
    .join('')
);

const lastLogin = computed(() => {
  const date = parseDbDate(props.user.lastLoginAt);
  if (!date) return t('admin.users.neverLoggedIn');
  return t('admin.users.lastLogin', {
    date: date.toLocaleString(locale.value),
  });
});

/** enabled admin that can't be demoted / disabled */
const isLastAdmin = computed(
  () =>
    props.user.role === 'ADMIN' && props.user.enabled && props.activeAdmins <= 1
);

const actions = computed(() => {
  const self = props.user.isSelf ? t('admin.users.selfHint') : undefined;
  const lastAdmin = isLastAdmin.value
    ? t('admin.users.lastAdminHint')
    : undefined;

  const result: {
    id: UserAction;
    label: string;
    disabledReason?: string;
  }[] = [];

  if (props.user.role === 'CLIENT') {
    result.push({
      id: 'promote',
      label: t('admin.users.promote'),
      disabledReason: self,
    });
  } else {
    result.push({
      id: 'demote',
      label: t('admin.users.demote'),
      disabledReason: self ?? lastAdmin,
    });
  }

  if (
    props.user.oauthProvider === 'oidc' &&
    props.user.roleSource === 'manual'
  ) {
    result.push({
      id: 'followOidc',
      label: t('admin.users.followOidc'),
      disabledReason: self,
    });
  }

  if (props.user.enabled) {
    result.push({
      id: 'disable',
      label: t('admin.users.disable'),
      disabledReason: self ?? lastAdmin,
    });
  } else {
    result.push({
      id: 'enable',
      label: t('admin.users.enable'),
      disabledReason: self,
    });
  }

  result.push({
    id: 'delete',
    label: t('admin.users.delete'),
    disabledReason: self ?? lastAdmin,
  });

  return result;
});

const _submit = useSubmit(
  (body) =>
    $fetch(`/api/admin/users/${props.user.id}`, {
      method: 'post',
      body,
    }),
  {
    revert: async () => {
      emit('changed');
    },
  }
);

const _deleteUser = useSubmit(
  () => $fetch(`/api/admin/users/${props.user.id}`, { method: 'delete' }),
  {
    revert: async () => {
      emit('changed');
    },
  }
);

function run(action: UserAction) {
  switch (action) {
    case 'promote':
      return _submit({ action: 'setRole', role: 'ADMIN' });
    case 'demote':
      return _submit({ action: 'setRole', role: 'CLIENT' });
    case 'followOidc':
      return _submit({ action: 'followOidc' });
    case 'disable':
      return _submit({ action: 'setEnabled', enabled: false });
    case 'enable':
      return _submit({ action: 'setEnabled', enabled: true });
    case 'delete':
      return _deleteUser(undefined);
  }
}
</script>
