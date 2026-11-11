<template>
  <BaseDialog>
    <template #trigger><slot /></template>
    <template #title>{{ title }}</template>
    <template #description>
      <div class="flex flex-col gap-3">
        <p>{{ description }}</p>
        <p
          v-if="note"
          class="rounded bg-blue-50 p-2 text-xs text-blue-800 dark:bg-blue-950 dark:text-blue-200"
        >
          {{ note }}
        </p>
      </div>
    </template>
    <template #actions>
      <DialogClose as-child>
        <BaseSecondaryButton>{{ $t('dialog.cancel') }}</BaseSecondaryButton>
      </DialogClose>
      <DialogClose as-child>
        <BasePrimaryButton @click="$emit('confirm')">
          {{ title }}
        </BasePrimaryButton>
      </DialogClose>
    </template>
  </BaseDialog>
</template>

<script setup lang="ts">
const props = defineProps<{
  action: UserAction;
  user: AdminUser;
  adminGroupsConfigured: boolean;
}>();

defineEmits<{ confirm: [] }>();

const { t } = useI18n();

const name = computed(() => `${props.user.name} (@${props.user.username})`);

const title = computed(() => t(`admin.users.${props.action}`));

const description = computed(() => {
  switch (props.action) {
    case 'promote':
      return t('admin.users.promoteDesc', { name: name.value });
    case 'demote':
      return t('admin.users.demoteDesc', { name: name.value });
    case 'followOidc':
      return t('admin.users.followOidcDesc', { name: name.value });
    case 'disable':
      return t('admin.users.disableDesc', { name: name.value });
    case 'enable':
      return t('admin.users.enableDesc', { name: name.value });
  }
  return '';
});

const note = computed(() => {
  if (props.action === 'promote' || props.action === 'demote') {
    return props.user.roleSource === 'oidc' ? t('admin.users.manualNote') : '';
  }
  if (props.action === 'followOidc') {
    // without admin groups (or groups) the role is kept
    if (!props.adminGroupsConfigured || !props.user.oidcGroups) {
      return t('admin.users.followOidcUnknown');
    }
    return props.user.matchedAdminGroups.length > 0
      ? t('admin.users.followOidcAdmin', {
          name: name.value,
          groups: props.user.matchedAdminGroups.join(', '),
        })
      : t('admin.users.followOidcClient', { name: name.value });
  }
  return '';
});
</script>
