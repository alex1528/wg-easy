<template>
  <BaseDialog @update:open="resetOnOpen">
    <template #trigger>
      <slot />
    </template>
    <template #title>
      {{ $t('admin.users.newUser') }}
    </template>
    <template #description>
      <div class="flex flex-col">
        <FormTextField
          id="newUserName"
          v-model="name"
          :label="$t('general.name')"
          :description="$t('admin.users.nameDesc')"
        />
        <FormTextField
          id="newUserUsername"
          v-model="username"
          :label="$t('general.username')"
          autocomplete="off"
        />
        <FormPasswordField
          id="newUserPassword"
          v-model="password"
          :label="$t('general.password')"
          autocomplete="new-password"
        />
        <FormLabel for="newUserRole">{{ $t('user.role') }}</FormLabel>
        <select
          id="newUserRole"
          v-model="role"
          class="rounded-lg border-2 border-gray-100 text-gray-500 focus:border-red-800 focus:outline-0 focus:ring-0 dark:border-neutral-800 dark:bg-neutral-700 dark:text-neutral-200"
        >
          <option value="CLIENT">{{ $t('user.roleClient') }}</option>
          <option value="ADMIN">{{ $t('user.roleAdmin') }}</option>
        </select>
        <p class="mt-2 text-xs text-gray-500 dark:text-neutral-400">
          {{ $t('admin.users.createHint') }}
        </p>
      </div>
    </template>
    <template #actions>
      <DialogClose as-child>
        <BaseSecondaryButton>{{ $t('dialog.cancel') }}</BaseSecondaryButton>
      </DialogClose>
      <DialogClose as-child>
        <BasePrimaryButton @click="createUser">
          {{ $t('admin.users.create') }}
        </BasePrimaryButton>
      </DialogClose>
    </template>
  </BaseDialog>
</template>

<script lang="ts" setup>
const emit = defineEmits<{ changed: [] }>();

const name = ref<string>('');
const username = ref<string>('');
const password = ref<string>('');
const role = ref<'CLIENT' | 'ADMIN'>('CLIENT');

const _createUser = useSubmit(
  (body) => $fetch('/api/admin/users', { method: 'post', body }),
  {
    revert: async () => {
      emit('changed');
    },
  }
);

function createUser() {
  return _createUser({
    username: username.value.trim(),
    password: password.value,
    name: name.value.trim() || undefined,
    role: role.value,
  });
}

function resetOnOpen(open: boolean) {
  if (open) {
    name.value = '';
    username.value = '';
    password.value = '';
    role.value = 'CLIENT';
  }
}
</script>
