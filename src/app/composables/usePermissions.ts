import type { Permissions } from '#shared/utils/permissions';

/**
 * Permission check of the logged in user (reactive).
 * `data` is a getter for the resource instance, needed for permissions
 * defined as functions (e.g. "the user's own clients").
 */
export function usePermission<Resource extends keyof Permissions>(
  resource: Resource,
  action: Permissions[Resource]['action'],
  data?: () => Permissions[Resource]['dataType'] | undefined
) {
  const authStore = useAuthStore();
  return computed(() => {
    const user = authStore.userData;
    if (!user) return false;
    return hasPermissions(user, resource, action, data?.());
  });
}
