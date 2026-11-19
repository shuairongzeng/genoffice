import iconDocx from './assets/file-docx.svg'
import iconXlsx from './assets/file-xlsx.svg'
import iconPptx from './assets/file-pptx.svg'
import iconPdf from './assets/file-pdf.svg'
import iconMd from './assets/file-md.svg'
import iconHtml from './assets/file-html.svg'

const FILE_ICONS: Record<string, string> = {
  docx: iconDocx,
  odt: iconDocx,
  ott: iconDocx,
  xlsx: iconXlsx,
  xlsm: iconXlsx,
  ods: iconXlsx,
  ots: iconXlsx,
  pptx: iconPptx,
  odp: iconPptx,
  otp: iconPptx,
  pdf: iconPdf,
  md: iconMd,
  markdown: iconMd,
  html: iconHtml,
  htm: iconHtml,
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico', 'avif'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv'])

function MediaFileBadge({ kind, size }: { kind: 'image' | 'audio' | 'video'; size: number }) {
  if (kind === 'image') {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect width="32" height="32" rx="7.5" fill="#059669" />
        <rect x="7" y="8" width="18" height="16" rx="2.5" stroke="#fff" strokeWidth="1.9" />
        <circle cx="12" cy="13" r="1.7" fill="#fff" />
        <path
          d="M8.5 21.5l5-5 3.4 3.2 2.4-2.3 4.2 4.1"
          stroke="#fff"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (kind === 'audio') {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect width="32" height="32" rx="7.5" fill="#7C3AED" />
        <path
          d="M14 20.5V10.5l9-2v10"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="11.5" cy="21" r="2.7" fill="#fff" />
        <circle cx="20.5" cy="19" r="2.7" fill="#fff" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="7.5" fill="#EA580C" />
      <rect x="6.5" y="8.5" width="19" height="15" rx="2.5" stroke="#fff" strokeWidth="1.9" />
      <path d="M14 12.6l6 3.4-6 3.4z" fill="#fff" />
    </svg>
  )
}

export function FileBadge({ ext, size }: { ext: string; size: number }) {
  const cleanExt = ext.toLowerCase()
  const icon = FILE_ICONS[cleanExt]
  if (icon) {
    return <img src={icon} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
  }
  if (IMAGE_EXTS.has(cleanExt)) return <MediaFileBadge kind="image" size={size} />
  if (AUDIO_EXTS.has(cleanExt)) return <MediaFileBadge kind="audio" size={size} />
  if (VIDEO_EXTS.has(cleanExt)) return <MediaFileBadge kind="video" size={size} />
  const label = cleanExt ? cleanExt[0].toUpperCase() : '?'
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7.5" fill="#98a2b3" />
      <text
        x="16"
        y="16.5"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#fff"
        fontSize={17}
        fontWeight="700"
        fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
      >
        {label}
      </text>
    </svg>
  )
}
