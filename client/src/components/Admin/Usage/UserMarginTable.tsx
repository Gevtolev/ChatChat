import React, { useMemo } from 'react';
import { DataTable } from '@librechat/client';
import { useLocalize } from '~/hooks';
import type { AdminUsageUserRow } from 'librechat-data-provider';
import type { Preset } from './UsagePanel';
import { creditsToUsd } from './format';

export default function UserMarginTable({
  users,
  preset,
}: {
  users: AdminUsageUserRow[];
  preset: Preset;
}) {
  const localize = useLocalize();
  /** Revenue is normalized to a 30-day figure server-side (see
   *  packages/api/src/admin/usage.ts). Comparing it against cost accrued over
   *  "This month" or "All time" would either overstate or understate margin,
   *  so those columns are hidden rather than shown with a misleading number. */
  const showMargin = preset === 'days30';

  const columns = useMemo(
    () => [
      {
        accessorKey: 'email',
        header: localize('com_ui_admin_usage_user'),
        cell: ({ row }: { row: { original: AdminUsageUserRow } }) => (
          <span className="font-mono text-xs">
            {/* A user deleted while their transactions remain has no email. */}
            {row.original.email ?? row.original.user_id}
          </span>
        ),
      },
      {
        accessorKey: 'plan_code',
        header: localize('com_ui_admin_usage_plan'),
        cell: ({ row }: { row: { original: AdminUsageUserRow } }) => {
          const { plan_code, plan_recognized } = row.original;
          if (!plan_recognized) {
            return (
              <span className="text-red-500" title={localize('com_ui_admin_usage_plan_unknown')}>
                {plan_code} ⚠
              </span>
            );
          }
          return <span>{plan_code ?? localize('com_ui_admin_usage_plan_implicit_free')}</span>;
        },
      },
      {
        accessorKey: 'cost_credits',
        header: localize('com_ui_admin_usage_cost'),
        cell: ({ row }: { row: { original: AdminUsageUserRow } }) =>
          `$${creditsToUsd(row.original.cost_credits)}`,
      },
      ...(showMargin
        ? [
            {
              accessorKey: 'revenue_credits',
              header: localize('com_ui_admin_usage_revenue'),
              cell: ({ row }: { row: { original: AdminUsageUserRow } }) =>
                `$${creditsToUsd(row.original.revenue_credits)}`,
            },
            {
              accessorKey: 'margin_credits',
              header: localize('com_ui_admin_usage_margin'),
              cell: ({ row }: { row: { original: AdminUsageUserRow } }) => {
                const margin = row.original.margin_credits;
                return (
                  <span className={margin < 0 ? 'font-medium text-red-500' : undefined}>
                    ${creditsToUsd(margin)}
                  </span>
                );
              },
            },
          ]
        : []),
      {
        accessorKey: 'calls',
        header: localize('com_ui_admin_usage_calls'),
      },
      {
        accessorKey: 'model_count',
        header: localize('com_ui_admin_usage_models'),
      },
    ],
    [localize, showMargin],
  );

  return (
    <div>
      {!showMargin && (
        <p className="mb-2 text-xs text-text-secondary">
          {localize('com_ui_admin_usage_margin_unavailable')}
        </p>
      )}
      <DataTable columns={columns} data={users} enableRowSelection={false} showCheckboxes={false} />
    </div>
  );
}
