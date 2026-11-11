<template>
  <ClientsCreateDialog v-if="canCreate">
    <BaseSecondaryButton as="span">
      <IconsPlus class="mr-2 w-4" />
      <span class="text-sm">{{ $t('client.newShort') }}</span>
    </BaseSecondaryButton>
  </ClientsCreateDialog>
</template>

<script setup lang="ts">
const canCreate = usePermission('clients', 'create');
</script>
