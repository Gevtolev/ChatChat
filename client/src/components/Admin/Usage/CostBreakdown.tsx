import React, { useMemo } from 'react';
import { useLocalize } from '~/hooks';
import type { AdminUsageModelRow } from 'librechat-data-provider';
import { creditsToUsd } from './format';

export default function CostBreakdown({ models }: { models: AdminUsageModelRow[] }) {
  const localize = useLocalize();

  const total = useMemo(() => models.reduce((sum, row) => sum + row.cost_credits, 0), [models]);

  if (models.length === 0) {
    return <p className="text-sm text-text-secondary">{localize('com_ui_admin_usage_empty')}</p>;
  }

  return (
    <table className="w-full text-sm" aria-label={localize('com_ui_admin_usage_breakdown')}>
      <thead>
        <tr className="border-b border-border-medium text-left text-text-secondary">
          <th scope="col" className="py-2">
            {localize('com_ui_admin_usage_model')}
          </th>
          <th scope="col">{localize('com_ui_admin_usage_context')}</th>
          <th scope="col">{localize('com_ui_admin_usage_cost')}</th>
          <th scope="col">{localize('com_ui_admin_usage_share')}</th>
          <th scope="col">{localize('com_ui_admin_usage_calls')}</th>
          <th scope="col">{localize('com_ui_admin_usage_cache_hit')}</th>
        </tr>
      </thead>
      <tbody>
        {models.map((row) => {
          const prompt = row.input_tokens + row.write_tokens + row.read_tokens;
          /** Cache hit rate answers whether caching is actually working for a
           *  model — the rate table can be right while caching never engages. */
          const hitRate = prompt > 0 ? Math.round((row.read_tokens / prompt) * 100) : 0;
          const share = total > 0 ? Math.round((row.cost_credits / total) * 100) : 0;
          return (
            <tr key={`${row.model}:${row.context}`} className="border-b border-border-light">
              <td className="py-2 font-mono text-xs">{row.model}</td>
              <td>{row.context}</td>
              <td>${creditsToUsd(row.cost_credits)}</td>
              <td>{share}%</td>
              <td>{row.calls}</td>
              <td>{prompt > 0 ? `${hitRate}%` : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
