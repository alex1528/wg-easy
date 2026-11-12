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
      v-model="input"
      :name="id"
      type="password"
      autocomplete="new-password"
      :placeholder="placeholder"
    />
    <div
      class="flex items-center gap-2 text-xs text-gray-500 dark:text-neutral-400"
    >
      <span>{{ status }}</span>
      <button
        v-if="hasDbValue && data !== null"
        type="button"
        class="underline hover:text-red-800"
        @click="data = null"
      >
        {{ $t('admin.oidc.clearSecret') }}
      </button>
      <button
        v-if="data !== undefined"
        type="button"
        class="underline hover:text-red-800"
        @click="data = undefined"
      >
        {{ $t('admin.oidc.keepSecret') }}
      </button>
    </div>
  </div>
</template>

<script lang="ts" setup>
/**
 * Write-only secret: undefined = keep, null = clear, string = set
 */
const props = defineProps<{
  id: string;
  label: string;
  description?: string;
  /** a value is stored in the database */
  hasDbValue: boolean;
  /** text describing the fallback when nothing is stored */
  fallbackText: string;
}>();

const { t } = useI18n();

const data = defineModel<string | null | undefined>();

const input = computed({
  get: () => (typeof data.value === 'string' ? data.value : ''),
  set: (value: unknown) => {
    const v = typeof value === 'string' ? value.trim() : '';
    data.value = v === '' ? undefined : v;
  },
});

const placeholder = computed(() =>
  props.hasDbValue ? '••••••••' : t('admin.oidc.secretPlaceholder')
);

const status = computed(() => {
  if (typeof data.value === 'string') return t('admin.oidc.secretWillSet');
  if (data.value === null) return t('admin.oidc.secretWillClear');
  if (props.hasDbValue) return t('admin.oidc.secretStored');
  return props.fallbackText;
});
</script>
