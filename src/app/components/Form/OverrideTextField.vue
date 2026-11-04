<template>
  <div class="flex items-center">
    <FormLabel :for="id">
      {{ label }}
    </FormLabel>
    <BaseTooltip v-if="description" :text="description">
      <IconsInfo class="size-4" />
    </BaseTooltip>
  </div>
  <div class="flex flex-col gap-1">
    <BaseInput
      :id="id"
      v-model.trim="data"
      :name="id"
      type="text"
      autocomplete="off"
      :placeholder="fallback ?? ''"
    />
    <div
      class="flex items-center gap-2 text-xs text-gray-500 dark:text-neutral-400"
    >
      <span v-if="data">{{ $t('admin.oidc.overridden') }}</span>
      <span v-else-if="fallback">
        {{ fallbackLabel }}
      </span>
      <span v-else>{{ $t('form.nullNotSet') }}</span>
      <button
        v-if="data"
        type="button"
        class="underline hover:text-red-800"
        @click="data = null"
      >
        {{ resetLabel ?? $t('admin.oidc.resetToEnv') }}
      </button>
    </div>
  </div>
</template>

<script lang="ts" setup>
const props = defineProps<{
  id: string;
  label: string;
  description?: string;
  /** value used when this field is empty */
  fallback?: string | null;
  /** 'env' or 'default' */
  fallbackSource?: 'env' | 'default';
  resetLabel?: string;
}>();

const { t } = useI18n();

const fallbackLabel = computed(() =>
  props.fallbackSource === 'default'
    ? t('admin.oidc.usingDefault')
    : t('admin.oidc.usingEnv')
);

const data = defineModel<string | null>({
  set(value) {
    const temp = value?.trim() ?? null;
    return temp === '' ? null : temp;
  },
});
</script>
