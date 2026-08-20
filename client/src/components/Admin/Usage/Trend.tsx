import React, { useMemo } from 'react';
import type { AdminUsageDayRow } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';
import { creditsToUsd } from './format';

const WIDTH = 640;
const HEIGHT = 120;
const PADDING = 4;

export default function Trend({ days }: { days: AdminUsageDayRow[] }) {
  const localize = useLocalize();

  const path = useMemo(() => {
    if (days.length < 2) {
      return '';
    }
    const peak = Math.max(...days.map((day) => day.cost_credits), 1);
    const stepX = (WIDTH - PADDING * 2) / (days.length - 1);
    return days
      .map((day, index) => {
        const x = PADDING + index * stepX;
        const y = HEIGHT - PADDING - (day.cost_credits / peak) * (HEIGHT - PADDING * 2);
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [days]);

  const total = useMemo(() => days.reduce((sum, day) => sum + day.cost_credits, 0), [days]);

  if (days.length === 0) {
    return (
      <p className="text-sm text-text-secondary">
        {localize('com_ui_admin_usage_empty' as TranslationKeys)}
      </p>
    );
  }

  return (
    <figure className="w-full">
      <figcaption className="mb-2 text-sm text-text-secondary">
        {localize('com_ui_admin_usage_trend_caption' as TranslationKeys, {
          total: creditsToUsd(total),
        })}
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-32 w-full"
        role="img"
        aria-label={localize('com_ui_admin_usage_trend' as TranslationKeys)}
        preserveAspectRatio="none"
      >
        {path !== '' && (
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="flex justify-between text-xs text-text-secondary">
        <span>{days[0].day}</span>
        <span>{days[days.length - 1].day}</span>
      </div>
    </figure>
  );
}
