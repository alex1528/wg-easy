<template>
  <p class="m-10 text-center text-sm text-gray-400 dark:text-neutral-400">
    {{ $t('client.empty') }}
    <template v-if="canCreate">
      <br /><br />
      <ClientsCreateDialog>
        <BaseSecondaryButton as="span">
          <IconsPlus class="mr-2 w-4" />
          <span class="text-sm">{{ $t('client.new') }}</span>
        </BaseSecondaryButton>
      </ClientsCreateDialog>
    </template>
  </p>
</template>

<script setup lang="ts">
const canCreate = usePermission('clients', 'create');
</script>
