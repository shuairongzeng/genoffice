import type { Lang } from '@genoffice/i18n'
import type { MediaPlayMode } from '../../shared/home-api'

export interface MediaPlayerStrings {
  playerTitle: string
  playlistTitle: string
  playlistToggle: string
  playlistCount: string
  searchPlaceholder: string
  allFolders: string
  addFolder: string
  addFiles: string
  pinFolder: string
  pinnedBadge: string
  removeFolderTitle: string
  removePinnedTitle: string
  emptyLibraryTitle: string
  emptyLibraryHint: string
  emptyFilterHint: string
  dropOverlayText: string
  prevTrack: string
  nextTrack: string
  playNextItem: string
  modeList: string
  modeLoopAll: string
  modeLoopOne: string
  modeShuffle: string
  subtitlesOn: string
  subtitlesOff: string
  subtitlesNone: string
  resumedFrom: string
  restartFromBeginning: string
  missingFolder: string
  doubleClickHint: string
  audioLabel: string
  videoLabel: string
  vizVinyl: string
  vizBars: string
  vizWave: string
  lyricsToggle: string
  lyricsEmpty: string
  audioLossless: string
  clickLyricSeek: string
}

const ZH_STRINGS: MediaPlayerStrings = {
  playerTitle: '播放器',
  playlistTitle: '播放列表',
  playlistToggle: '播放列表',
  playlistCount: '{n} 个媒体',
  searchPlaceholder: '搜索音频或视频文件名…',
  allFolders: '全部',
  addFolder: '+ 文件夹',
  addFiles: '+ 文件',
  pinFolder: '记住此目录',
  pinnedBadge: '已记住',
  removeFolderTitle: '从播放库移除此目录（不删除本地文件）',
  removePinnedTitle: '从播放列表移除',
  emptyLibraryTitle: '媒体播放库还是空的',
  emptyLibraryHint: '添加音视频文件夹或单曲，也可以直接把文件夹、音频、视频拖放到这里自动播放。',
  emptyFilterHint: '当前筛选条件下没有匹配的音视频',
  dropOverlayText: '松开以添加到播放列表并播放',
  prevTrack: '上一曲',
  nextTrack: '下一曲',
  playNextItem: '播放下一项',
  modeList: '顺序播放',
  modeLoopAll: '列表循环',
  modeLoopOne: '单曲循环',
  modeShuffle: '随机播放',
  subtitlesOn: '字幕：开',
  subtitlesOff: '字幕：关',
  subtitlesNone: '无同目录字幕',
  resumedFrom: '已从 {time} 续播',
  restartFromBeginning: '从头播放',
  missingFolder: '目录暂不可访问',
  doubleClickHint: '双击曲目即可播放',
  audioLabel: '音频',
  videoLabel: '视频',
  vizVinyl: '黑胶星环',
  vizBars: '镜像频谱',
  vizWave: '流体声波',
  lyricsToggle: '歌词',
  lyricsEmpty: '同目录放入同名 .lrc 歌词文件即可同步滚动',
  audioLossless: 'Hi-Res 无损',
  clickLyricSeek: '点击跳转至该句',
}

const ZH_TW_STRINGS: MediaPlayerStrings = {
  playerTitle: '播放器',
  playlistTitle: '播放清單',
  playlistToggle: '播放清單',
  playlistCount: '{n} 個媒體',
  searchPlaceholder: '搜尋音訊或影片檔名…',
  allFolders: '全部',
  addFolder: '+ 資料夾',
  addFiles: '+ 檔案',
  pinFolder: '記住此資料夾',
  pinnedBadge: '已記住',
  removeFolderTitle: '從播放庫移除此資料夾（不刪除本機檔案）',
  removePinnedTitle: '從播放清單移除',
  emptyLibraryTitle: '媒體播放庫還是空的',
  emptyLibraryHint: '加入音訊影片資料夾或檔案，也可直接將資料夾或音影片拖放到此處自動播放。',
  emptyFilterHint: '目前篩選條件下沒有符合的媒體',
  dropOverlayText: '放開以加入播放清單並播放',
  prevTrack: '上一曲',
  nextTrack: '下一曲',
  playNextItem: '播放下一項',
  modeList: '順序播放',
  modeLoopAll: '清單循環',
  modeLoopOne: '單曲循環',
  modeShuffle: '隨機播放',
  subtitlesOn: '字幕：開',
  subtitlesOff: '字幕：關',
  subtitlesNone: '無同資料夾字幕',
  resumedFrom: '已從 {time} 續播',
  restartFromBeginning: '從頭播放',
  missingFolder: '資料夾暫時無法存取',
  doubleClickHint: '雙擊項目即可播放',
  audioLabel: '音訊',
  videoLabel: '影片',
  vizVinyl: '黑膠星環',
  vizBars: '鏡像頻譜',
  vizWave: '流體聲波',
  lyricsToggle: '歌詞',
  lyricsEmpty: '於同資料夾放入同名 .lrc 歌詞檔即可同步捲動',
  audioLossless: 'Hi-Res 無損',
  clickLyricSeek: '點擊跳轉至該句',
}

const EN_STRINGS: MediaPlayerStrings = {
  playerTitle: 'Media Player',
  playlistTitle: 'Playlist',
  playlistToggle: 'Playlist',
  playlistCount: '{n} items',
  searchPlaceholder: 'Search audio or video…',
  allFolders: 'All',
  addFolder: '+ Folder',
  addFiles: '+ Files',
  pinFolder: 'Pin folder',
  pinnedBadge: 'Pinned',
  removeFolderTitle: 'Remove folder from library (disk files untouched)',
  removePinnedTitle: 'Remove from playlist',
  emptyLibraryTitle: 'Your media library is empty',
  emptyLibraryHint: 'Add an audio/video folder or drop folders and media files here to start playing.',
  emptyFilterHint: 'No matching audio or video files',
  dropOverlayText: 'Drop to add and play now',
  prevTrack: 'Previous',
  nextTrack: 'Next',
  playNextItem: 'Play next track',
  modeList: 'Order',
  modeLoopAll: 'Loop All',
  modeLoopOne: 'Loop One',
  modeShuffle: 'Shuffle',
  subtitlesOn: 'Subtitles: On',
  subtitlesOff: 'Subtitles: Off',
  subtitlesNone: 'No sidecar subtitles',
  resumedFrom: 'Resumed at {time}',
  restartFromBeginning: 'Restart',
  missingFolder: 'Folder unavailable',
  doubleClickHint: 'Double-click any item to play',
  audioLabel: 'Audio',
  videoLabel: 'Video',
  vizVinyl: 'Vinyl Halo',
  vizBars: 'Mirror Bars',
  vizWave: 'Fluid Wave',
  lyricsToggle: 'Lyrics',
  lyricsEmpty: 'Add a matching .lrc file alongside the track for synced lyrics',
  audioLossless: 'Hi-Res Lossless',
  clickLyricSeek: 'Click line to seek',
}

const STRINGS_BY_LANG: Partial<Record<Lang, MediaPlayerStrings>> = {
  zh: ZH_STRINGS,
  'zh-TW': ZH_TW_STRINGS,
  en: EN_STRINGS,
}

export function getMediaPlayerStrings(lang: Lang): MediaPlayerStrings {
  return STRINGS_BY_LANG[lang] ?? EN_STRINGS
}

export function playModeLabel(strings: MediaPlayerStrings, mode: MediaPlayMode): string {
  switch (mode) {
    case 'list':
      return strings.modeList
    case 'loop-all':
      return strings.modeLoopAll
    case 'loop-one':
      return strings.modeLoopOne
    case 'shuffle':
      return strings.modeShuffle
  }
}
