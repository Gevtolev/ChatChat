import React, { useMemo, useState } from 'react';
import { SystemRoles } from 'librechat-data-provider';
import { Spinner } from '@librechat/client';
import { useAuthContext, useLocalize } from '~/hooks';
import { useAdminUsageQuery } from '~/data-provider';
import UserMarginTable from './UserMarginTable';
import CostBreakdown from './CostBreakdown';
import Trend from './Trend';

type Preset = 'month' | 'days30' | 'all';

/** Defaults to a rolling 30 days rather than the calendar month: billing
 *  anchors differ per user, so a rolling window is what compares against a
 *  monthly fee, and it reacts sooner to someone who just started burning. */
function rangeFor(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  if (preset === 'all') {
    return { from: new Date(0).toISOString(), to };
  }
  if (preset === 'month') {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to };
  }
  return { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), to };
}

export default function UsagePanel() {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const [preset, setPreset] = useState<Preset>('days30');

  const range = useMemo(() => rangeFor(preset), [preset]);
  const isAdmin = user?.role === SystemRoles.ADMIN;
  const { data, isLoading, error } = useAdminUsageQuery(range, { enabled: isAdmin });

  /** UX only — the real guard is requireCapability on the route. */
  if (!isAdmin) {
    return <div className="p-6">{localize('com_ui_admin_usage_forbidden')}</div>;
  }

  const presets: Preset[] = ['month', 'days30', 'all'];
  const labels: Record<Preset, string> = {
    month: localize('com_ui_admin_usage_range_month'),
    days30: localize('com_ui_admin_usage_range_30d'),
    all: localize('com_ui_admin_usage_range_all'),
  };

  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-medium">{localize('com_ui_admin_usage_title')}</h1>
        <div role="group" aria-label={localize('com_ui_admin_usage_range')} className="flex gap-2">
          {presets.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setPreset(option)}
              aria-pressed={preset === option}
              className={`rounded px-3 py-1 text-sm ${
                preset === option ? 'bg-surface-tertiary font-medium' : 'text-text-secondary'
              }`}
            >
              {labels[option]}
            </button>
          ))}
        </div>
      </header>

      {isLoading && (
        <div role="status" aria-live="polite" aria-label={localize('com_ui_loading')}>
          <Spinner />
        </div>
      )}
      {error != null && <p className="text-red-500">{localize('com_ui_admin_usage_error')}</p>}

      {data != null && (
        <>
          <section aria-labelledby="usage-users">
            <h2 id="usage-users" className="mb-2 text-lg">
              {localize('com_ui_admin_usage_by_user')}
            </h2>
            <UserMarginTable users={data.users} />
          </section>

          <section aria-labelledby="usage-breakdown">
            <h2 id="usage-breakdown" className="mb-2 text-lg">
              {localize('com_ui_admin_usage_breakdown')}
            </h2>
            <CostBreakdown models={data.models} />
          </section>

          <section aria-labelledby="usage-trend">
            <h2 id="usage-trend" className="mb-2 text-lg">
              {localize('com_ui_admin_usage_trend')}
            </h2>
            <Trend days={data.days} />
            <p className="mt-2 text-xs text-text-secondary">
              {localize('com_ui_admin_usage_rate_change_note')}
            </p>
          </section>
        </>
      )}
    </main>
  );
}
