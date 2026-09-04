import React from 'react';
import { VisuallyHidden } from '@ariakit/react';
import { CheckCircle2, Pin, PinOff } from 'lucide-react';
import type { TModelSpec } from 'librechat-data-provider';
import { useFavorites, useLocalize, useIsActiveItem } from '~/hooks';
import { useModelSelectorContext } from '../ModelSelectorContext';
import { CustomMenuItem as MenuItem } from '../CustomMenu';
import SpecIcon from './SpecIcon';
import { cn } from '~/utils';

interface ModelSpecItemProps {
  spec: TModelSpec;
  isSelected: boolean;
}

export function ModelSpecItem({ spec, isSelected }: ModelSpecItemProps) {
  const localize = useLocalize();
  const { handleSelectSpec, endpointsConfig, lockedSpecs } = useModelSelectorContext();
  const { isFavoriteSpec, toggleFavoriteSpec } = useFavorites();
  const { showIconInMenu = true } = spec;

  const { ref: itemRef, isActive } = useIsActiveItem<HTMLDivElement>();

  const isFavorite = isFavoriteSpec(spec.name);
  /**
   * Shown but not selectable, rather than hidden. A locked model is the clearest
   * statement of what a subscription buys — hiding it means a free user never
   * learns the product has an Opus tier at all. Selecting it used to be allowed
   * and failed only after the message was sent, which put the refusal at the
   * worst possible moment.
   */
  const isLocked = lockedSpecs.has(spec.name);

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleFavoriteSpec(spec.name);
  };

  return (
    <MenuItem
      ref={itemRef}
      onClick={isLocked ? undefined : () => handleSelectSpec(spec)}
      disabled={isLocked}
      aria-selected={isSelected || undefined}
      aria-disabled={isLocked || undefined}
      /** The reason travels with the row rather than only in a hover tooltip,
       *  which a keyboard or touch user never sees. */
      title={isLocked ? localize('com_ui_model_locked_upgrade') : undefined}
      /** `CustomMenuItem` fades disabled rows to 25%, which is legible enough
       *  for something you are meant to ignore. A locked model is the opposite
       *  — it is the advertisement — so `twMerge` lets a later utility raise it
       *  to something readable. */
      className={cn(
        'group flex w-full items-center justify-between rounded-lg px-2 text-sm',
        isLocked ? 'cursor-not-allowed aria-disabled:opacity-60' : 'cursor-pointer',
      )}
    >
      <div
        className={cn(
          'flex w-full min-w-0 gap-2 px-1 py-1',
          spec.description ? 'items-start' : 'items-center',
        )}
      >
        {showIconInMenu && (
          <div className="flex-shrink-0">
            <SpecIcon currentSpec={spec} endpointsConfig={endpointsConfig} />
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-left">{spec.label}</span>
          {isLocked ? (
            <span className="break-words text-xs font-normal text-text-tertiary">
              {localize('com_ui_model_locked_upgrade')}
            </span>
          ) : (
            spec.description && (
              <span className="break-words text-xs font-normal">{spec.description}</span>
            )
          )}
        </div>
      </div>
      <button
        type="button"
        tabIndex={isActive ? 0 : -1}
        onClick={handleFavoriteClick}
        aria-label={isFavorite ? localize('com_ui_unpin') : localize('com_ui_pin')}
        className={cn(
          'rounded-md p-1 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring-primary',
          isFavorite
            ? 'visible'
            : 'invisible group-focus-within:visible group-hover:visible group-data-[active-item]:visible',
        )}
      >
        {isFavorite ? (
          <PinOff className="h-4 w-4 text-text-secondary" aria-hidden="true" />
        ) : (
          <Pin className="h-4 w-4 text-text-secondary" aria-hidden="true" />
        )}
      </button>
      {isSelected && (
        <>
          <CheckCircle2
            className="size-4 shrink-0 self-center text-text-primary"
            aria-hidden="true"
          />
          <VisuallyHidden>{localize('com_a11y_selected')}</VisuallyHidden>
        </>
      )}
    </MenuItem>
  );
}

export function renderModelSpecs(specs: TModelSpec[], selectedSpec: string) {
  if (!specs || specs.length === 0) {
    return null;
  }

  return specs.map((spec) => (
    <ModelSpecItem key={spec.name} spec={spec} isSelected={selectedSpec === spec.name} />
  ));
}
