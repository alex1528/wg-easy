<template>
  <div class="mb-6">
    <Panel>
      <PanelHead>
        <PanelHeadTitle>{{ $t('connect.title') }}</PanelHeadTitle>
        <PanelHeadBoat>
          <BaseSecondaryButton
            class="flex items-center gap-2"
            :title="$t('connect.refresh')"
            :disabled="loading"
            @click="refresh"
          >
            <IconsLoading v-if="loading" class="size-4 animate-spin" />
            {{ $t('connect.refresh') }}
          </BaseSecondaryButton>
        </PanelHeadBoat>
      </PanelHead>
      <PanelBody>
        <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <!-- QR code A: LiveWireGuard / OIDC setup -->
          <section class="flex flex-col items-center gap-2 text-center">
            <h3 class="text-lg font-semibold">
              {{ $t('connect.setupTitle') }}
            </h3>
            <template v-if="data?.setup.configured">
              <ConnectSetupQr
                :text="data.setup.text"
                :alt="$t('connect.setupTitle')"
              />
              <p class="text-sm text-gray-500 dark:text-neutral-300">
                {{ $t('connect.setupDesc') }}
              </p>
              <div class="flex flex-wrap justify-center gap-2">
                <a
                  :href="data.setup.text"
                  class="inline-flex items-center gap-2 rounded bg-gray-100 px-3 py-2 text-sm transition hover:bg-red-800 hover:text-white dark:bg-neutral-600 dark:text-neutral-300 dark:hover:bg-red-800 dark:hover:text-white"
                  data-testid="setup-open"
                >
                  <IconsLink class="size-4" />
                  {{ $t('connect.setupOpen') }}
                </a>
                <button
                  type="button"
                  class="inline-flex items-center gap-2 rounded bg-gray-100 px-3 py-2 text-sm transition hover:bg-red-800 hover:text-white dark:bg-neutral-600 dark:text-neutral-300 dark:hover:bg-red-800 dark:hover:text-white"
                  data-testid="setup-copy"
                  @click="copySetupLink(data.setup.text)"
                >
                  <IconsCopy class="size-4" />
                  {{
                    linkCopied
                      ? $t('connect.setupCopied')
                      : $t('connect.setupCopy')
                  }}
                </button>
              </div>
              <p
                v-if="!data.setup.endpointEnabled"
                class="flex items-center gap-1 text-sm text-amber-600 dark:text-amber-400"
              >
                <IconsWarning class="size-4 shrink-0" />
                {{ $t('connect.endpointDisabled') }}
              </p>
            </template>
            <div v-else :class="placeholderClass">
              {{
                data ? $t('connect.oidcNotConfigured') : $t('general.loading')
              }}
            </div>
          </section>

          <!-- QR code B: the user's own WireGuard client -->
          <section class="flex flex-col items-center gap-2 text-center">
            <h3 class="text-lg font-semibold">
              {{ $t('connect.clientTitle') }}
            </h3>
            <template v-if="data?.client">
              <div class="relative inline-block rounded bg-white p-2">
                <img
                  :src="clientQrUrl"
                  :alt="data.client.name"
                  class="size-48"
                  data-testid="client-qr"
                />
                <div
                  v-if="!data.client.enabled"
                  class="absolute inset-0 flex items-center justify-center rounded bg-white/85 p-4 text-sm font-semibold text-gray-700"
                >
                  {{ $t('connect.clientDisabled') }}
                </div>
              </div>
              <p class="text-sm text-gray-500 dark:text-neutral-300">
                {{ data.client.name }}
              </p>
              <div class="flex flex-wrap justify-center gap-2">
                <a
                  :href="`/api/client/${data.client.id}/configuration`"
                  download
                  class="inline-flex items-center gap-2 rounded bg-gray-100 px-3 py-2 text-sm transition hover:bg-red-800 hover:text-white dark:bg-neutral-600 dark:text-neutral-300 dark:hover:bg-red-800 dark:hover:text-white"
                >
                  <IconsDownload class="size-4" />
                  {{ $t('client.downloadConfig') }}
                </a>
                <BaseDialog trigger-class="inline-flex">
                  <template #trigger>
                    <span
                      class="inline-flex items-center gap-2 rounded bg-gray-100 px-3 py-2 text-sm transition hover:bg-red-800 hover:text-white dark:bg-neutral-600 dark:text-neutral-300 dark:hover:bg-red-800 dark:hover:text-white"
                    >
                      <IconsSparkles class="size-4" />
                      {{ $t('connect.regenerate') }}
                    </span>
                  </template>
                  <template #title>{{ $t('connect.regenerate') }}</template>
                  <template #description>
                    {{ $t('connect.regenerateDesc') }}
                  </template>
                  <template #actions>
                    <DialogClose as-child>
                      <BaseSecondaryButton>
                        {{ $t('dialog.cancel') }}
                      </BaseSecondaryButton>
                    </DialogClose>
                    <DialogClose as-child>
                      <BasePrimaryButton :disabled="creating" @click="create">
                        {{ $t('connect.regenerate') }}
                      </BasePrimaryButton>
                    </DialogClose>
                  </template>
                </BaseDialog>
              </div>
            </template>
            <template v-else>
              <div :class="placeholderClass">
                {{ data ? $t('connect.noClient') : $t('general.loading') }}
              </div>
              <BasePrimaryButton
                v-if="data"
                :disabled="creating"
                @click="create"
              >
                {{ $t('connect.generate') }}
              </BasePrimaryButton>
            </template>
          </section>
        </div>
      </PanelBody>
    </Panel>
  </div>
</template>

<script setup lang="ts">
type ConnectData = Awaited<ReturnType<typeof fetchConnect>>;

const clientsStore = useClientsStore();

const placeholderClass =
  'flex size-52 items-center justify-center rounded border-2 border-dashed border-gray-200 bg-gray-50 p-4 text-sm text-gray-400 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-400';

const data = ref<ConnectData | null>(null);
const linkCopied = ref(false);

async function copySetupLink(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    linkCopied.value = true;
    setTimeout(() => (linkCopied.value = false), 1600);
  } catch (e) {
    console.error('failed to copy setup link', e);
  }
}
const loading = ref(false);
const creating = ref(false);

function fetchConnect() {
  return $fetch('/api/me/connect', { method: 'get' });
}

/** the revision changes with the config, so the image is never stale */
const clientQrUrl = computed(() => {
  const client = data.value?.client;
  if (!client) return '';
  return `/api/client/${client.id}/qrcode.svg?rev=${client.revision}`;
});

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  try {
    const next = await fetchConnect();
    // keep the old object when nothing changed (no flicker)
    if (JSON.stringify(next) !== JSON.stringify(data.value)) {
      data.value = next;
    }
  } catch (e) {
    console.error('failed to load connect info', e);
  } finally {
    loading.value = false;
  }
}

const _create = useSubmit(
  () => $fetch('/api/me/connect/client', { method: 'post' }),
  {
    revert: async () => {
      creating.value = false;
      await Promise.all([refresh(), clientsStore.refresh()]);
    },
  }
);

function create() {
  creating.value = true;
  return _create(undefined);
}

// changes made in the client list below (toggle, rename, ...) refresh at once
const ownClientState = computed(() => {
  const id = data.value?.client?.id;
  if (id === undefined) return null;
  const c = clientsStore.clients?.find((v) => v.id === id);
  return c ? `${c.enabled}-${c.name}-${c.updatedAt}` : 'missing';
});
watch(ownClientState, (now, before) => {
  if (before !== undefined && now !== before) {
    void refresh();
  }
});

// server side changes (host, port, dns, OIDC settings, ...)
const { resume } = useTimeoutPoll(refresh, 5000, { immediate: false });

onMounted(async () => {
  await refresh();
  resume();
});
</script>
