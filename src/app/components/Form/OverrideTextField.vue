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
      @focus="onFocus"
      @blur="onBlur"
    />
    <div
      class="flex items-center gap-2 text-xs text-gray-500 dark:text-neutral-400"
    >
      <span v-if="isOverridden">{{ $t('admin.oidc.overridden') }}</span>
      <span v-else-if="fallback">
        {{ fallbackLabel }}
        <template v-if="prefillFallback">
          · {{ $t('form.editFallbackHint') }}
        </template>
      </span>
      <span v-else>{{ $t('form.nullNotSet') }}</span>
      <button
        v-if="isOverridden"
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
  /**
   * put the fallback into the empty input on focus, so it can be edited
   * instead of retyped. Left unchanged, the field stays empty (not set).
   */
  prefillFallback?: boolean;
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

/** a value equal to the fallback is not an override while prefilling */
const isOverridden = computed(
  () =>
    !!data.value && !(props.prefillFallback && data.value === props.fallback)
);

async function onFocus(e: FocusEvent) {
  if (!props.prefillFallback || data.value || !props.fallback) return;
  data.value = props.fallback;
  // caret at the end, ready to edit
  await nextTick();
  const input = e.target as HTMLInputElement | null;
  if (input && document.activeElement === input) {
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }
}

function onBlur() {
  // unchanged: keep following the fallback (env / default)
  if (props.prefillFallback && data.value === props.fallback) {
    data.value = null;
  }
}
</script>
