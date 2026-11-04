<template>
  <div class="inline-block rounded bg-white p-2">
    <img
      v-if="url"
      :src="url"
      :alt="alt"
      class="size-48"
      data-testid="setup-qr"
    />
  </div>
</template>

<script setup lang="ts">
import { encodeQR } from 'qr';

const props = defineProps<{ text: string; alt?: string }>();

const url = ref<string | null>(null);

function render(text: string) {
  if (url.value) {
    URL.revokeObjectURL(url.value);
  }
  let svg: string;
  try {
    svg = encodeQR(text, 'svg', { ecc: 'medium', scale: 4, encoding: 'byte' });
  } catch {
    // long payloads (e.g. big secrets): lower the error correction
    svg = encodeQR(text, 'svg', { ecc: 'low', scale: 4, encoding: 'byte' });
  }
  url.value = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
}

onMounted(() => render(props.text));

// only re-render when the encoded content changes
watch(
  () => props.text,
  (text, old) => {
    if (text !== old) render(text);
  }
);

onBeforeUnmount(() => {
  if (url.value) URL.revokeObjectURL(url.value);
});
</script>
