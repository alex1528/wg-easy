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
          class="flex items-center gap-1 text-sm text-amber-600 dark:text-amber-400"
        >
          <IconsWarning class="size-4 shrink-0" />
          {{ $t('connect.endpointDisabled') }}
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
  };
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
