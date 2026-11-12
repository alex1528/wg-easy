/**
 * Errors of the OAuth browser flows come back as `?oauth_error=<i18n key>`
 * (see server/utils/i18nError.ts). Show them as a toast and clean the url.
 * @returns true if the page was opened with an OAuth error
 */
export function useOauthError() {
  const route = useRoute();
  const router = useRouter();
  const toast = useToast();
  const { t, te } = useI18n();

  const raw = route.query.oauth_error;
  const key = typeof raw === 'string' && raw !== '' ? raw : null;

  onMounted(() => {
    if (!key) return;
    const known = key.startsWith('error.') && (te(key) || te(key, 'en'));
    toast.showToast({
      type: 'error',
      message: known ? t(key) : t('error.oauthFailed'),
    });
    const { oauth_error: _, ...query } = route.query;
    void router.replace({ query });
  });

  return key !== null;
}
