import { render, screen, fireEvent } from '@testing-library/react';
import type { TModelSpec } from 'librechat-data-provider';
import { ModelSpecItem } from '../ModelSpecItem';

const mockHandleSelectSpec = jest.fn();
const mockToggleFavoriteSpec = jest.fn();
let mockIsFavoriteSpec = false;
let mockIsActive = false;

/** Mutable so a test can lock a spec without re-mocking the context. */
const mockLockedSpecs = new Set<string>();

jest.mock('~/components/Chat/Menus/Endpoints/ModelSelectorContext', () => ({
  useModelSelectorContext: () => ({
    handleSelectSpec: mockHandleSelectSpec,
    endpointsConfig: {},
    lockedSpecs: mockLockedSpecs,
  }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/CustomMenu', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    CustomMenuItem: React.forwardRef(function MockMenuItem(
      { children, ...rest }: { children?: React.ReactNode },
      ref: React.Ref<HTMLDivElement>,
    ) {
      return React.createElement('div', { ref, role: 'menuitem', ...rest }, children);
    }),
  };
});

jest.mock('../SpecIcon', () => ({
  __esModule: true,
  default: () => <span data-testid="spec-icon" />,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useFavorites: () => ({
    isFavoriteSpec: () => mockIsFavoriteSpec,
    toggleFavoriteSpec: mockToggleFavoriteSpec,
  }),
  useIsActiveItem: () => ({ ref: { current: null }, isActive: mockIsActive }),
}));

const baseSpec: TModelSpec = {
  name: 'my-spec',
  label: 'My Spec',
  preset: {
    endpoint: 'openai',
    model: 'gpt-5',
  },
};

describe('ModelSpecItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFavoriteSpec = false;
    mockIsActive = false;
    mockLockedSpecs.clear();
  });

  it('renders the spec label and icon', () => {
    render(<ModelSpecItem spec={baseSpec} isSelected={false} />);
    expect(screen.getByText('My Spec')).toBeInTheDocument();
    expect(screen.getByTestId('spec-icon')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(
      <ModelSpecItem spec={{ ...baseSpec, description: 'Fast and cheap' }} isSelected={false} />,
    );
    expect(screen.getByText('Fast and cheap')).toBeInTheDocument();
  });

  it('renders aria-selected=true when isSelected', () => {
    render(<ModelSpecItem spec={baseSpec} isSelected={true} />);
    expect(screen.getByRole('menuitem')).toHaveAttribute('aria-selected', 'true');
  });

  it('does NOT set aria-selected when not selected', () => {
    render(<ModelSpecItem spec={baseSpec} isSelected={false} />);
    expect(screen.getByRole('menuitem')).not.toHaveAttribute('aria-selected');
  });

  it('calls handleSelectSpec on row click', () => {
    render(<ModelSpecItem spec={baseSpec} isSelected={false} />);
    fireEvent.click(screen.getByRole('menuitem'));
    expect(mockHandleSelectSpec).toHaveBeenCalledWith(baseSpec);
  });

  /** The whole point of the change: a plan the user does not have used to be
   *  discoverable only by picking the model, sending, and being refused. */
  describe('when the spec is locked by the plan', () => {
    beforeEach(() => {
      mockLockedSpecs.add(baseSpec.name);
    });

    it('does not select it on click', () => {
      render(<ModelSpecItem spec={baseSpec} isSelected={false} />);
      fireEvent.click(screen.getByRole('menuitem'));
      expect(mockHandleSelectSpec).not.toHaveBeenCalled();
    });

    it('marks it disabled for assistive technology', () => {
      render(<ModelSpecItem spec={baseSpec} isSelected={false} />);
      expect(screen.getByRole('menuitem')).toHaveAttribute('aria-disabled', 'true');
    });

    /** In the row, not only in a hover tooltip — a keyboard or touch user never
     *  sees the latter. */
    it('states why, in place of the description', () => {
      render(<ModelSpecItem spec={baseSpec} isSelected={false} />);
      expect(screen.getByText('com_ui_model_locked_upgrade')).toBeInTheDocument();
      if (baseSpec.description) {
        expect(screen.queryByText(baseSpec.description)).not.toBeInTheDocument();
      }
    });
  });

  describe('pin button', () => {
    it('renders Pin icon with "com_ui_pin" label when not favorited', () => {
      mockIsFavoriteSpec = false;
      render(<ModelSpecItem spec={baseSpec} isSelected={false} />);
      expect(screen.getByRole('button', { name: 'com_ui_pin' })).toBeInTheDocument();
    });

    it('renders PinOff icon with "com_ui_unpin" label when favorited', () => {
      mockIsFavoriteSpec = true;
      render(<ModelSpecItem spec={baseSpec} isSelected={false} />);
      expect(screen.getByRole('button', { name: 'com_ui_unpin' })).toBeInTheDocument();
    });

    it('calls toggleFavoriteSpec with spec.name on click', () => {
      render(<ModelSpecItem spec={baseSpec} isSelected={false} />);
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_pin' }));
      expect(mockToggleFavoriteSpec).toHaveBeenCalledWith('my-spec');
    });

    it('stops propagation so handleSelectSpec is not fired', () => {
      render(<ModelSpecItem spec={baseSpec} isSelected={false} />);
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_pin' }));
      expect(mockHandleSelectSpec).not.toHaveBeenCalled();
    });

    it('has tabIndex=-1 when item is not active', () => {
      mockIsActive = false;
      render(<ModelSpecItem spec={baseSpec} isSelected={false} />);
      expect(screen.getByRole('button', { name: 'com_ui_pin' })).toHaveAttribute('tabindex', '-1');
    });

    it('has tabIndex=0 when item is active', () => {
      mockIsActive = true;
      render(<ModelSpecItem spec={baseSpec} isSelected={false} />);
      expect(screen.getByRole('button', { name: 'com_ui_pin' })).toHaveAttribute('tabindex', '0');
    });
  });
});
