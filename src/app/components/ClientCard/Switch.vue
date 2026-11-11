<template>
  <span
    v-if="!canToggle"
    class="flex items-center gap-1 px-1 text-xs"
    :title="$t('client.setByAdmin')"
  >
    <span
      class="inline-block size-2 rounded-full"
      :class="client.enabled ? 'bg-green-500' : 'bg-gray-400'"
    />
    {{
      client.enabled ? $t('client.enabled') : $t('admin.users.statusDisabled')
    }}
  </span>
  <BaseSwitch
    v-else
    :model-value="enabled"
    :title="
      client.enabled ? $t('client.disableClient') : $t('client.enableClient')
    "
    @update:model-value="toggleClient"
  />
</template>

<script setup lang="ts">
const props = defineProps<{
  client: LocalClient;
}>();

const canToggle = usePermission('clients', 'toggle');

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
