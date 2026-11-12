<template>
  <main v-if="data && form">
    <FormElement @submit.prevent="submit">
      <FormGroup>
        <FormHeading :description="$t('admin.oidc.panelDesc')">
          {{ $t('admin.oidc.panel') }}
        </FormHeading>
        <FormNullSwitchField
          id="oidcEnabled"
          v-model="form.enabled"
          :label="$t('admin.oidc.enabled')"
          :description="
            $t('admin.oidc.enabledDesc', {
              env: data.env.enabled ? $t('general.yes') : $t('general.no'),
            })
          "
        />
        <FormOverrideTextField
          id="oidcFriendlyName"
          v-model="form.friendlyName"
          :label="$t('admin.oidc.friendlyName')"
          :description="$t('admin.oidc.friendlyNameDesc')"
          :fallback="data.env.friendlyName ?? data.defaults.friendlyName"
          :fallback-source="data.env.friendlyName ? 'env' : 'default'"
        />
        <FormOverrideTextField
          id="oidcServer"
          v-model="form.server"
          :label="$t('admin.oidc.server')"
          :description="$t('admin.oidc.serverDesc')"
          :fallback="data.env.server"
          fallback-source="env"
        />
        <FormOverrideTextField
          id="oidcClientId"
          v-model="form.clientId"
          :label="$t('admin.oidc.clientId')"
          :description="$t('admin.oidc.clientIdDesc')"
          :fallback="data.env.clientId"
          fallback-source="env"
        />
        <FormSecretField
          id="oidcClientSecret"
          v-model="secrets.clientSecret"
          :label="$t('admin.oidc.clientSecret')"
          :description="$t('admin.oidc.clientSecretDesc')"
          :has-db-value="data.db.hasClientSecret"
          :fallback-text="
            data.env.hasClientSecret
              ? $t('admin.oidc.usingEnv')
              : $t('form.nullNotSet')
          "
        />
        <FormInfoField
          id="oidcStatus"
          :label="$t('admin.oidc.status')"
          :data="
            data.effective.isConfigured
              ? $t('admin.oidc.statusConfigured')
              : $t('admin.oidc.statusNotConfigured')
          "
        />
        <FormInfoField
          id="oidcCallback"
          :label="$t('admin.oidc.panelRedirect')"
          :description="$t('admin.oidc.panelRedirectDesc')"
          :data="panelRedirect"
        />
      </FormGroup>

      <FormGroup>
        <FormHeading :description="$t('admin.oidc.roleMappingDesc')">
          {{ $t('admin.oidc.roleMapping') }}
        </FormHeading>
        <div class="flex items-center">
          <FormLabel for="adminGroups">
            {{ $t('admin.oidc.adminGroups') }}
          </FormLabel>
          <BaseTooltip :text="$t('admin.oidc.adminGroupsDesc')">
            <IconsInfo class="size-4" />
          </BaseTooltip>
        </div>
        <div class="flex flex-col gap-1">
          <FormNullArrayField
            v-model="form.adminGroups"
            name="adminGroups"
            :empty-text="adminGroupsFallback"
          />
        </div>
        <FormOverrideTextField
          id="oidcGroupsClaim"
          v-model="form.groupsClaim"
          :label="$t('admin.oidc.groupsClaim')"
          :description="$t('admin.oidc.groupsClaimDesc')"
          :fallback="data.env.groupsClaim ?? data.defaults.groupsClaim"
          :fallback-source="data.env.groupsClaim ? 'env' : 'default'"
          :reset-label="
            data.env.groupsClaim ? undefined : $t('admin.oidc.resetToDefault')
          "
        />
        <FormOverrideTextField
          id="oidcPanelScopes"
          v-model="form.panelScopes"
          :label="$t('admin.oidc.panelScopes')"
          :description="$t('admin.oidc.panelScopesDesc')"
          :fallback="data.env.panelScopes ?? data.defaults.panelScopes"
          :fallback-source="data.env.panelScopes ? 'env' : 'default'"
          :reset-label="
            data.env.panelScopes ? undefined : $t('admin.oidc.resetToDefault')
          "
        />
        <FormLabel for="oidcRules">{{ $t('admin.oidc.rules') }}</FormLabel>
        <ul
          id="oidcRules"
          class="list-disc rounded-lg bg-gray-50 py-2 pl-6 pr-3 text-sm text-gray-600 dark:bg-neutral-800 dark:text-neutral-300"
        >
          <li v-for="i in 5" :key="i">{{ $t(`admin.oidc.rule${i}`) }}</li>
        </ul>
        <template v-if="data.self">
          <FormLabel for="oidcSelfCheck">
            {{ $t('admin.oidc.selfCheck') }}
          </FormLabel>
          <div
            id="oidcSelfCheck"
            class="rounded-lg border p-3 text-sm"
            :class="
              data.self.matched.length > 0
                ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-200'
                : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200'
            "
          >
            <template v-if="data.self.groups && data.self.groups.length > 0">
              <div class="mb-1">{{ $t('admin.oidc.selfGroups') }}</div>
              <span
                v-for="group in data.self.groups"
                :key="group"
                class="mb-1 mr-1 inline-block rounded px-1.5 py-0.5 font-mono text-xs"
                :class="
                  data.self.matched.includes(group)
                    ? 'bg-green-200 font-semibold dark:bg-green-900'
                    : 'bg-white/70 dark:bg-neutral-700'
                "
              >
                {{ group }}
              </span>
              <div class="mt-1">
                {{
                  data.self.matched.length > 0
                    ? $t('admin.oidc.selfMatched', {
                        groups: data.self.matched.join(', '),
                      })
                    : $t('admin.oidc.selfNotMatched')
                }}
              </div>
            </template>
            <template v-else>{{ $t('admin.oidc.selfNoGroups') }}</template>
          </div>
        </template>
        <template v-if="data.effective.adminGroups.length > 0">
          <div class="flex items-center">
            <FormLabel for="oidcResync">
              {{ $t('admin.oidc.resync') }}
            </FormLabel>
            <BaseTooltip :text="$t('admin.oidc.resyncDesc')">
              <IconsInfo class="size-4" />
            </BaseTooltip>
          </div>
          <div>
            <BaseSecondaryButton
              id="oidcResync"
              type="button"
              class="w-full justify-center"
              @click="resync"
            >
              {{ $t('admin.oidc.resync') }}
            </BaseSecondaryButton>
          </div>
        </template>
      </FormGroup>

      <FormGroup>
        <FormHeading :description="$t('admin.oidc.appDesc')">
          {{ $t('admin.oidc.app') }}
        </FormHeading>
        <FormOverrideTextField
          id="oidcAppClientId"
          v-model="form.appClientId"
          :label="$t('admin.oidc.appClientId')"
          :description="$t('admin.oidc.appClientIdDesc')"
          :fallback="data.effective.clientId"
          :reset-label="$t('admin.oidc.resetToPanel')"
          fallback-source="env"
        />
        <FormSecretField
          id="oidcAppClientSecret"
          v-model="secrets.appClientSecret"
          :label="$t('admin.oidc.appClientSecret')"
          :description="$t('admin.oidc.appClientSecretDesc')"
          :has-db-value="data.db.hasAppClientSecret"
          :fallback-text="
            form.appClientId
              ? $t('form.nullNotSet')
              : $t('admin.oidc.usingPanelSecret')
          "
        />
        <FormOverrideTextField
          id="oidcAppScopes"
          v-model="form.appScopes"
          :label="$t('admin.oidc.appScopes')"
          :description="$t('admin.oidc.appScopesDesc')"
          :fallback="data.defaults.appScopes"
          fallback-source="default"
          :reset-label="$t('admin.oidc.resetToDefault')"
        />
        <FormOverrideTextField
          id="oidcAppRedirectUri"
          v-model="form.appRedirectUri"
          :label="$t('admin.oidc.appRedirectUri')"
          :description="$t('admin.oidc.appRedirectUriDesc')"
          :fallback="data.defaults.appRedirectUri"
          fallback-source="default"
          :reset-label="$t('admin.oidc.resetToDefault')"
        />
        <FormOverrideTextField
          id="oidcEndpointUrl"
          v-model="form.endpointUrl"
          :label="$t('admin.oidc.endpointUrl')"
          :description="$t('admin.oidc.endpointUrlDesc')"
          :fallback="data.defaults.endpointUrl"
          fallback-source="default"
          :reset-label="$t('admin.oidc.resetToDefault')"
          prefill-fallback
        />
      </FormGroup>

      <FormGroup>
        <FormHeading>{{ $t('form.actions') }}</FormHeading>
        <FormPrimaryActionField type="submit" :label="$t('form.save')" />
        <FormSecondaryActionField :label="$t('form.revert')" @click="revert" />
      </FormGroup>
    </FormElement>

    <section class="mt-6 flex flex-col gap-3">
      <h3 class="text-2xl">{{ $t('admin.oidc.preview') }}</h3>
      <template v-if="setup?.configured">
        <p
          v-if="!setup.endpointEnabled"
          class="flex flex-wrap items-center gap-1 text-sm text-amber-600 dark:text-amber-400"
        >
          <IconsWarning class="size-4 shrink-0" />
          {{ $t('connect.endpointDisabled') }}
          <NuxtLink to="/admin/general" class="underline hover:text-red-800">
            {{ $t('connect.endpointEnable') }}
          </NuxtLink>
        </p>
        <div>
          <ConnectSetupQr :text="setup.text" :alt="$t('admin.oidc.preview')" />
        </div>
        <p class="text-sm text-gray-500 dark:text-neutral-300">
          {{ $t('admin.oidc.previewDesc') }}
        </p>
        <BaseCodeBlock :code="prettyPayload" />
      </template>
      <p v-else class="text-sm text-gray-500 dark:text-neutral-300">
        {{ $t('connect.oidcNotConfigured') }}
      </p>
    </section>
  </main>
</template>

<script setup lang="ts">
type SecretValue = string | null | undefined;

const { data, refresh } = await useFetch('/api/admin/oidc', {
  method: 'get',
});
const { data: setup, refresh: refreshSetup } = await useFetch(
  '/api/admin/oidc/setup',
  { method: 'get' }
);

function formFromData() {
  if (!data.value) return null;
  const db = data.value.db;
  return {
    enabled: db.enabled,
    friendlyName: db.friendlyName,
    server: db.server,
    clientId: db.clientId,
    appClientId: db.appClientId,
    appScopes: db.appScopes,
    appRedirectUri: db.appRedirectUri,
    endpointUrl: db.endpointUrl,
    adminGroups: db.adminGroups ? [...db.adminGroups] : null,
    groupsClaim: db.groupsClaim,
    panelScopes: db.panelScopes,
  };
}

const { t } = useI18n();
const toast = useToast();

const adminGroupsFallback = computed(() => {
  const envGroups = data.value?.env.adminGroups;
  if (envGroups && envGroups.length > 0) {
    return t('admin.oidc.adminGroupsEnv', { groups: envGroups.join(', ') });
  }
  return t('admin.oidc.adminGroupsNone');
});

const _resync = useSubmit(
  () => $fetch('/api/admin/oidc/resync', { method: 'post' }),
  {
    revert: async (success, res) => {
      if (success && res) {
        toast.showToast({
          type: 'success',
          message: t('admin.oidc.resyncDone', {
            changed: res.changed,
            skipped: res.skipped,
          }),
        });
      }
    },
    noSuccessToast: true,
  }
);

function resync() {
  return _resync(undefined);
}

const form = ref(formFromData());
const secrets = reactive<{
  clientSecret: SecretValue;
  appClientSecret: SecretValue;
}>({ clientSecret: undefined, appClientSecret: undefined });

const panelRedirect = ref('');
onMounted(() => {
  panelRedirect.value = `${window.location.origin}/api/auth/oidc/callback`;
});

const prettyPayload = computed(() => {
  if (!setup.value?.configured) return '';
  return JSON.stringify(setup.value.payload, null, 2);
});

const _submit = useSubmit(
  (body) => $fetch('/api/admin/oidc', { method: 'post', body }),
  { revert: async () => revert() }
);

function submit() {
  if (!form.value) return;
  const body: Record<string, unknown> = { ...form.value };
  // undefined secrets are left out: keep the stored value
  if (secrets.clientSecret !== undefined) {
    body.clientSecret = secrets.clientSecret;
  }
  if (secrets.appClientSecret !== undefined) {
    body.appClientSecret = secrets.appClientSecret;
  }
  return _submit(body);
}

async function revert() {
  await Promise.all([refresh(), refreshSetup()]);
  form.value = formFromData();
  secrets.clientSecret = undefined;
  secrets.appClientSecret = undefined;
}
</script>
