<template>
  <span
    :title="
      canToggle
        ? client.enabled
          ? $t('client.disableClient')
          : $t('client.enableClient')
        : $t('client.setByAdmin')
    "
  >
    <BaseSwitch
      :model-value="enabled"
      :disabled="!canToggle"
      @update:model-value="toggleClient"
    />
  </span>
</template>

<script setup lang="ts">
const props = defineProps<{
  client: LocalClient;
}>();

const canToggle = usePermission('clients', 'toggle', () => ({
  id: props.client.id,
  userId: props.client.userId,
}));

const enabled = ref(props.client.enabled);

watch(
  () => props.client.enabled,
  (value) => {
    enabled.value = value;
  }
);

const clientsStore = useClientsStore();

const _disableClient = useSubmit(
  (data) =>
    $fetch(`/api/client/${props.client.id}/disable`, {
      method: 'post',
      body: data,
    }),
  {
    revert: async () => {
      await clientsStore.refresh();
    },
    noSuccessToast: true,
  }
);

const _enableClient = useSubmit(
  (data) =>
    $fetch(`/api/client/${props.client.id}/enable`, {
      method: 'post',
      body: data,
    }),
  {
    revert: async () => {
      await clientsStore.refresh();
    },
    noSuccessToast: true,
  }
);

async function toggleClient(nextEnabled: boolean | undefined) {
  if (nextEnabled === undefined) return;

  // Update immediately while the request and store refresh are in progress.
  enabled.value = nextEnabled;

  if (nextEnabled) {
    await _enableClient(undefined);
  } else {
    await _disableClient(undefined);
  }
}
</script>
