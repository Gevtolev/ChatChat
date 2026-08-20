import { useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type { AdminUsageParams, AdminUsageResponse } from 'librechat-data-provider';

/**
 * Admin-only cost aggregate for a date range.
 *
 * Not refetched on window focus: the underlying aggregation scans a date range
 * of transactions, and the numbers do not move meaningfully between tab
 * switches. The range is part of the key, so switching presets refetches.
 */
export const useAdminUsageQuery = (
  params: AdminUsageParams,
  config?: UseQueryOptions<AdminUsageResponse>,
): QueryObserverResult<AdminUsageResponse> => {
  return useQuery<AdminUsageResponse>(
    [QueryKeys.adminUsage, params.from, params.to],
    () => dataService.getAdminUsage(params),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};
