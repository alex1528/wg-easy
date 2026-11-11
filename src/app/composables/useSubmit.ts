import { FetchError } from 'ofetch';

type RevertFn<T> = (success: boolean, data: T | undefined) => Promise<void>;

type SubmitOpts<T> = {
  revert: RevertFn<T>;
  successMsg?: string;
  noSuccessToast?: boolean;
};

type Body = Record<string, unknown> | null | undefined;

export function useSubmit<T>(
  fetcher: (data: Body) => Promise<T>,
  opts: SubmitOpts<T>
) {
  const toast = useToast();
  const authStore = useAuthStore();
  const route = useRoute();
  const { t } = useI18n();

  return async (data: Body) => {
    try {
      const res = await fetcher(data);

      if (!opts.noSuccessToast) {
        toast.showToast({
          type: 'success',
          message: opts.successMsg,
        });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await opts.revert(true, res as any);
    } catch (e) {
      if (e instanceof FetchError && e.statusCode === 403) {
        // role changed (e.g. demoted by another admin) or user disabled
        await authStore.update();
        const user = authStore.userData;
        const lostAdmin =
          route.path.startsWith('/admin') &&
          (!user || !hasPermissions(user, 'admin', 'any'));
        toast.showToast({
          type: 'error',
          message: lostAdmin
            ? t('toast.permissionChanged')
            : (e.data?.message ?? t('toast.permissionChanged')),
        });
        if (!user) {
          await navigateTo('/login');
          return;
        }
        if (lostAdmin) {
          await navigateTo('/');
          return;
        }
      } else if (e instanceof FetchError) {
        toast.showToast({
          type: 'error',
          message: e.data.message,
        });
      } else if (e instanceof Error) {
        toast.showToast({
          type: 'error',
          message: e.message,
        });
      } else {
        console.error(e);
      }
      await opts.revert(false, undefined);
    }
  };
}
