import { useEffect } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { bootstrapSmalliceSession, fetchSmalliceSession, getSmalliceMainSiteUrl } from './lib/smalliceSession'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import SupportPromptModal from './components/SupportPromptModal'
import { useGlobalClickSuppression } from './lib/clickSuppression'

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const appMode = useStore((s) => s.appMode)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const bootstrap = await bootstrapSmalliceSession().catch((error) => ({
        status: 'failed' as const,
        message: error instanceof Error ? error.message : String(error),
      }))
      const session = await fetchSmalliceSession().catch(() => null)
      if (cancelled || session?.authenticated) return

      const mainSiteUrl = getSmalliceMainSiteUrl()
      const message =
        bootstrap.status === 'failed'
          ? `Smallice AI 授权同步失败：${bootstrap.message}\n\n请先返回主站完成登录，然后从主站入口重新打开 Draw。`
          : '未获取到 Smallice AI 登录信息。\n\n请先返回主站完成登录，然后从主站入口重新打开 Draw。'

      setConfirmDialog({
        title: '需要登录 Smallice AI',
        message,
        confirmText: '返回主站登录',
        showCancel: false,
        icon: 'info',
        dismissible: false,
        action: () => {
          window.location.assign(mainSiteUrl)
        },
      })
    })()

    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)

    setSettings(nextSettings)

    if (hasUrlSettingParams(searchParams)) {
      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    initStore()
    return () => {
      cancelled = true
    }
  }, [setConfirmDialog, setSettings])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  return (
    <>
      <Header />
      {appMode === 'agent' ? (
        <AgentWorkspace />
      ) : (
        <main data-home-main data-drag-select-surface className="pb-48">
          <div className="safe-area-x max-w-7xl mx-auto">
            <SearchBar />
            <TaskGrid />
          </div>
        </main>
      )}
      <InputBar />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <SupportPromptModal />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
