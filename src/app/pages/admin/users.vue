<template>
  <main v-if="data" class="flex flex-col gap-4">
    <p class="text-sm text-gray-500 dark:text-neutral-300">
      {{ $t('admin.users.desc') }}
    </p>

    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <div
        v-for="stat in stats"
        :key="stat.id"
        class="rounded-lg border border-gray-100 px-4 py-3 dark:border-neutral-600"
      >
        <div class="text-xs text-gray-500 dark:text-neutral-400">
          {{ stat.label }}
        </div>
        <div class="font-mono text-2xl font-semibold">{{ stat.value }}</div>
      </div>
    </div>

    <div
      v-if="legacyAdmins > 0"
      class="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300"
    >
      <IconsWarning class="mt-0.5 size-4 shrink-0" />
      <div>
        {{ $t('admin.users.legacyAdmins', { count: legacyAdmins }) }}
        <NuxtLink to="/admin/oidc" class="ml-1 underline hover:text-red-800">
          {{ $t('admin.users.configureGroups') }}
        </NuxtLink>
      </div>
    </div>

    <div class="flex flex-col gap-3 md:flex-row md:items-center">
      <BaseInput
        id="userSearch"
        v-model="search"
        type="search"
        class="md:flex-1"
        :placeholder="$t('admin.users.search')"
      />
      <div
        class="flex overflow-hidden rounded border-2 border-gray-100 text-sm dark:border-neutral-600"
        role="tablist"
      >
        <button
          v-for="f in filters"
          :key="f.id"
          type="button"
          role="tab"
          :aria-selected="filter === f.id"
          class="px-3 py-1.5 transition"
          :class="
            filter === f.id
              ? 'bg-red-800 text-white'
              : 'hover:bg-gray-100 dark:hover:bg-neutral-600'
          "
          @click="filter = f.id"
        >
          {{ f.label }}
        </button>
      </div>
      <AdminUsersCreateDialog @changed="refresh">
        <BaseSecondaryButton as="span">
          <IconsPlus class="mr-2 w-4" />
          <span class="text-sm">{{ $t('admin.users.newUser') }}</span>
        </BaseSecondaryButton>
      </AdminUsersCreateDialog>
    </div>

    <div
      class="divide-y divide-gray-100 rounded-lg border border-gray-100 dark:divide-neutral-600 dark:border-neutral-600"
    >
      <AdminUserRow
        v-for="u in filteredUsers"
        :key="u.id"
        :user="u"
        :active-admins="activeAdmins"
        :admin-groups-configured="data.adminGroupsConfigured"
        :max-clients="data.maxClientsPerUser"
        @changed="refresh"
      />
      <p
        v-if="filteredUsers.length === 0"
        class="p-6 text-center text-sm text-gray-400 dark:text-neutral-400"
      >
        {{ $t('admin.users.empty') }}
      </p>
    </div>
  </main>
</template>

<script setup lang="ts">
const { t } = useI18n();

const { data, refresh } = await useFetch('/api/admin/users', {
  method: 'get',
});

type Filter = 'all' | 'admin' | 'client' | 'disabled';

const search = ref('');
const filter = ref<Filter>('all');

const users = computed(() => data.value?.users ?? []);

const activeAdmins = computed(
  () => users.value.filter((u) => u.role === 'ADMIN' && u.enabled).length
);

/** OIDC managed admins that will never be demoted without admin groups */
const legacyAdmins = computed(() => {
  if (!data.value || data.value.adminGroupsConfigured) return 0;
  return users.value.filter(
    (u) => u.role === 'ADMIN' && u.roleSource === 'oidc'
  ).length;
});

const stats = computed(() => [
  { id: 'total', label: t('admin.users.total'), value: users.value.length },
  {
    id: 'admins',
    label: t('admin.users.admins'),
    value: users.value.filter((u) => u.role === 'ADMIN').length,
  },
  {
    id: 'clients',
    label: t('admin.users.clients'),
    value: users.value.filter((u) => u.role === 'CLIENT').length,
  },
  {
    id: 'disabled',
    label: t('admin.users.disabled'),
    value: users.value.filter((u) => !u.enabled).length,
  },
]);

const filters = computed<{ id: Filter; label: string }[]>(() => [
  { id: 'all', label: t('admin.users.filterAll') },
  { id: 'admin', label: t('admin.users.filterAdmin') },
  { id: 'client', label: t('admin.users.filterClient') },
  { id: 'disabled', label: t('admin.users.filterDisabled') },
]);

const filteredUsers = computed(() => {
  const q = search.value.trim().toLowerCase();
  return users.value.filter((u) => {
    if (filter.value === 'admin' && u.role !== 'ADMIN') return false;
    if (filter.value === 'client' && u.role !== 'CLIENT') return false;
    if (filter.value === 'disabled' && u.enabled) return false;
    if (!q) return true;
    return [u.username, u.name, u.email ?? ''].some((v) =>
      v.toLowerCase().includes(q)
    );
  });
});
</script>
