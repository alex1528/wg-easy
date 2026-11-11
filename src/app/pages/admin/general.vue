<template>
  <main v-if="data">
    <FormElement @submit.prevent="submit">
      <FormGroup>
        <FormNumberField
          id="session"
          v-model="data.sessionTimeout"
          :label="$t('admin.general.sessionTimeout')"
          :description="$t('admin.general.sessionTimeoutDesc')"
        />
      </FormGroup>
      <FormGroup>
        <FormHeading>{{ $t('admin.general.clients') }}</FormHeading>
        <FormNumberField
          id="maxClientsPerUser"
          v-model="data.maxClientsPerUser"
          :label="$t('admin.general.maxClientsPerUser')"
          :description="$t('admin.general.maxClientsPerUserDesc')"
        />
        <span
          class="col-span-2 text-xs text-gray-500 md:col-span-1 md:col-start-2 dark:text-neutral-400"
        >
          {{
            data.maxClientsPerUser === 0
              ? $t('admin.general.maxClientsPerUserUnlimited')
              : $t('admin.general.maxClientsPerUserHint')
          }}
        </span>
      </FormGroup>
      <FormGroup>
        <FormHeading>{{ $t('admin.general.metrics') }}</FormHeading>
        <FormNullTextField
          id="password"
          v-model="data.metricsPassword"
          :label="$t('admin.general.metricsPassword')"
          :description="$t('admin.general.metricsPasswordDesc')"
        />
        <FormSwitchField
          id="prometheus"
          v-model="data.metricsPrometheus"
          :label="$t('admin.general.prometheus')"
          :description="$t('admin.general.prometheusDesc')"
        />
        <FormSwitchField
          id="json"
          v-model="data.metricsJson"
          :label="$t('admin.general.json')"
          :description="$t('admin.general.jsonDesc')"
        />
      </FormGroup>
      <FormGroup>
        <FormHeading>{{ $t('admin.general.liveWireGuard') }}</FormHeading>
        <FormSwitchField
          id="liveWireGuard"
          v-model="data.liveWireGuardEnabled"
          :label="$t('admin.general.liveWireGuardEnabled')"
          :description="$t('admin.general.liveWireGuardEnabledDesc')"
        />
        <div class="flex items-center">
          <FormLabel for="liveWireGuardStatus">
            {{ $t('admin.general.liveWireGuardStatus') }}
          </FormLabel>
          <BaseTooltip :text="$t('admin.general.liveWireGuardStatusDesc')">
            <IconsInfo class="size-4" />
          </BaseTooltip>
        </div>
        <div id="liveWireGuardStatus" class="flex flex-col justify-center">
          <span class="flex items-center gap-2">
            <span
              class="inline-block size-2 rounded-full"
              :class="savedLiveWireGuard ? 'bg-green-500' : 'bg-gray-400'"
            />
            {{
              savedLiveWireGuard
                ? $t('admin.general.liveWireGuardStatusOn')
                : $t('admin.general.liveWireGuardStatusOff')
            }}
          </span>
          <span
            v-if="savedLiveWireGuard !== data.liveWireGuardEnabled"
            class="text-xs text-amber-600 dark:text-amber-400"
          >
            {{ $t('admin.general.unsaved') }}
          </span>
        </div>
        <FormTextField
          id="liveWireGuardAudience"
          v-model="data.liveWireGuardAudience"
          :label="$t('admin.general.liveWireGuardAudience')"
          :description="$t('admin.general.liveWireGuardAudienceDesc')"
        />
        <FormOverrideTextField
          id="liveWireGuardEndpoint"
          v-model="data.liveWireGuardEndpointUrl"
          :label="$t('admin.general.liveWireGuardEndpoint')"
          :description="$t('admin.general.liveWireGuardEndpointDesc')"
          :fallback="data.liveWireGuardEndpointDefault"
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
  </main>
</template>

<script setup lang="ts">
const { data: _data, refresh } = await useFetch(`/api/admin/general`, {
  method: 'get',
});
const data = toRef(_data.value);

/** saved value (the form object is edited in place) */
const savedLiveWireGuard = ref(_data.value?.liveWireGuardEnabled ?? false);

const _submit = useSubmit(
  (data) =>
    $fetch(`/api/admin/general`, {
      method: 'post',
      body: data,
    }),
  { revert }
);

function submit() {
  return _submit(data.value);
}

async function revert() {
  await refresh();
  data.value = toRef(_data.value).value;
  savedLiveWireGuard.value = _data.value?.liveWireGuardEnabled ?? false;
}
</script>
