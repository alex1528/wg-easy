<template>
  <BaseDialog :trigger-class="triggerClass" @update:open="resetOnOpen">
    <template #trigger>
      <slot />
    </template>
    <template #title>
      {{ $t('client.new') }}
    </template>
    <template #description>
      <div class="flex flex-col">
        <FormTextField id="name" v-model="name" :label="$t('client.name')" />
        <FormDateField
          id="expiresAt"
          v-model="expiresAt"
          :label="$t('client.expireDate')"
        />
        <div v-if="owners.length > 1" class="mt-2 flex flex-col gap-1">
          <FormLabel for="clientOwner">{{ $t('client.owner') }}</FormLabel>
          <select
            id="clientOwner"
            v-model="ownerId"
            class="rounded-lg border-2 border-gray-100 text-gray-500 focus:border-red-800 focus:outline-0 focus:ring-0 dark:border-neutral-800 dark:bg-neutral-700 dark:text-neutral-200"
          >
            <option v-for="owner in owners" :key="owner.id" :value="owner.id">
              {{
                owner.isSelf
                  ? `${$t('client.ownerSelf')} (@${owner.username})`
                  : `${owner.name} (@${owner.username})`
              }}
            </option>
          </select>
        </div>
      </div>
    </template>
    <template #actions>
      <DialogClose as-child>
        <BaseSecondaryButton>{{ $t('dialog.cancel') }}</BaseSecondaryButton>
      </DialogClose>
      <DialogClose as-child>
        <BasePrimaryButton @click="createClient">
          {{ $t('client.create') }}
        </BasePrimaryButton>
      </DialogClose>
    </template>
  </BaseDialog>
</template>

<script lang="ts" setup>
const name = ref<string>('');
const expiresAt = ref<string | null>(null);
const ownerId = ref<number | null>(null);
const owners = ref<
  { id: number; username: string; name: string; isSelf: boolean }[]
>([]);
const authStore = useAuthStore();
const clientsStore = useClientsStore();

const { t } = useI18n();

defineProps<{ triggerClass?: string }>();

function resetOnOpen(open: boolean) {
  if (!open) return;

  name.value = '';
  expiresAt.value = null;
  ownerId.value = authStore.userData?.id ?? null;
  void loadOwners();
}

/** only admins can create clients, and only admins can list users */
async function loadOwners() {
  try {
    const res = await $fetch('/api/admin/users', { method: 'get' });
    owners.value = res.users
      .filter((u) => u.enabled)
      .map((u) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        isSelf: u.isSelf,
      }));
  } catch {
    owners.value = [];
  }
}

function createClient() {
  return _createClient({
    name: name.value,
    expiresAt: expiresAt.value,
    ...(ownerId.value !== null && ownerId.value !== authStore.userData?.id
      ? { userId: ownerId.value }
      : {}),
  });
}

const _createClient = useSubmit(
  (data) =>
    $fetch('/api/client', {
      method: 'post',
      body: data,
    }),
  {
    revert: () => clientsStore.refresh(),
    successMsg: t('client.created'),
  }
);
</script>
