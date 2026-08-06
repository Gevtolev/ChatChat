import { useState, useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { Outlet, useNavigate } from 'react-router-dom';
import { SystemRoles } from 'librechat-data-provider';
import { useMediaQuery } from '@librechat/client';
import {
  useSearchEnabled,
  useAssistantsMap,
  useAuthContext,
  useLocalize,
  useAgentsMap,
  useFileMap,
} from '~/hooks';
import store from '~/store';
import {
  PromptGroupsProvider,
  AssistantsMapContext,
  AgentsMapContext,
  SetConvoProvider,
  FileMapContext,
} from '~/Providers';
import { useUserTermsQuery, useGetStartupConfig } from '~/data-provider';
import KeyboardShortcutsDialog from '~/components/Nav/KeyboardShortcutsDialog';
import KeyboardDeleteDialog from '~/components/Nav/KeyboardDeleteDialog';
import useKeyboardShortcuts from '~/hooks/useKeyboardShortcuts';
import GuestUpgradeModal from '~/components/Auth/GuestUpgradeModal';
import { UnifiedSidebar } from '~/components/UnifiedSidebar';
import { TermsAndConditionsModal } from '~/components/ui';
import { useHealthCheck } from '~/data-provider';
import { Banner } from '~/components/Banners';

/** Isolates keyboard shortcut listeners so they only mount after auth. */
function KeyboardShortcutsProvider() {
  useKeyboardShortcuts();
  return (
    <>
      <KeyboardShortcutsDialog />
      <KeyboardDeleteDialog />
    </>
  );
}

export default function Root() {
  const [showTerms, setShowTerms] = useState(false);
  const [bannerHeight, setBannerHeight] = useState(0);
  const sidebarExpanded = useRecoilValue(store.sidebarExpanded);
  const isSmallScreen = useMediaQuery('(max-width: 768px)');

  const navigate = useNavigate();
  const localize = useLocalize();
  const { user, isAuthenticated, logout } = useAuthContext();
  /**
   * GUEST (anonymous) accounts can't list agents/assistants — skip the fetch rather than let it
   * 403. Requires `user` to already be loaded (not just `isAuthenticated`) since the two can
   * commit in separate renders, which would otherwise let this default to `true` for a tick.
   */
  const isGuest = isAuthenticated && !!user && user.role === SystemRoles.GUEST;
  const canUseAgentsAndAssistants = isAuthenticated && !!user && user.role !== SystemRoles.GUEST;

  useHealthCheck(isAuthenticated);

  const assistantsMap = useAssistantsMap({ isAuthenticated: canUseAgentsAndAssistants });
  const agentsMap = useAgentsMap({ isAuthenticated: canUseAgentsAndAssistants });
  const fileMap = useFileMap({ isAuthenticated });

  const { data: config } = useGetStartupConfig();
  const { data: termsData } = useUserTermsQuery({
    enabled: isAuthenticated && config?.interface?.termsOfService?.modalAcceptance === true,
  });

  useSearchEnabled(isAuthenticated);

  useEffect(() => {
    if (termsData) {
      setShowTerms(!termsData.termsAccepted);
    }
  }, [termsData]);

  const handleAcceptTerms = () => {
    setShowTerms(false);
  };

  const handleDeclineTerms = () => {
    setShowTerms(false);
    logout('/login?redirect=false');
  };

  if (!isAuthenticated) {
    return null;
  }

  return (
    <SetConvoProvider>
      <FileMapContext.Provider value={fileMap}>
        <AssistantsMapContext.Provider value={assistantsMap}>
          <AgentsMapContext.Provider value={agentsMap}>
            <PromptGroupsProvider>
              <Banner onHeightChange={setBannerHeight} />
              <div className="flex" style={{ height: `calc(100dvh - ${bannerHeight}px)` }}>
                <div className="relative z-0 flex h-full w-full overflow-hidden">
                  {isGuest ? (
                    <div className="relative flex h-full max-w-full flex-1 flex-col overflow-hidden">
                      <div className="absolute right-3 top-2.5 z-20">
                        <button
                          onClick={() => navigate('/login')}
                          className="inline-flex h-9 items-center justify-center rounded-full border border-border-medium bg-surface-primary px-4 text-sm font-medium text-text-primary shadow-sm transition-all hover:bg-surface-hover hover:shadow-md"
                        >
                          {localize('com_auth_login')}
                        </button>
                      </div>
                      <Outlet />
                      <GuestUpgradeModal />
                    </div>
                  ) : (
                    <>
                      <UnifiedSidebar />
                      <div
                        className="relative flex h-full max-w-full flex-1 flex-col overflow-hidden"
                        style={{
                          transform:
                            isSmallScreen && sidebarExpanded
                              ? 'translateX(min(85vw, 380px))'
                              : 'none',
                          transition: 'transform 300ms cubic-bezier(0.2, 0, 0, 1)',
                        }}
                        inert={isSmallScreen && sidebarExpanded ? '' : undefined}
                      >
                        <Outlet />
                      </div>
                    </>
                  )}
                </div>
              </div>
            </PromptGroupsProvider>
          </AgentsMapContext.Provider>
          {config?.interface?.termsOfService?.modalAcceptance === true && (
            <TermsAndConditionsModal
              open={showTerms}
              onOpenChange={setShowTerms}
              onAccept={handleAcceptTerms}
              onDecline={handleDeclineTerms}
              title={config.interface.termsOfService.modalTitle}
              modalContent={config.interface.termsOfService.modalContent}
            />
          )}
          <KeyboardShortcutsProvider />
        </AssistantsMapContext.Provider>
      </FileMapContext.Provider>
    </SetConvoProvider>
  );
}
