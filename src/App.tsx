import { useState, useRef, useCallback } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import './App.css'

interface VideoFile {
  id: string
  file: File
  name: string
  duration: number
  thumbnail: string
}

function App() {
  const [videos, setVideos] = useState<VideoFile[]>([])
  const [fadeDuration, setFadeDuration] = useState(1.5)
  const [isProcessing, setIsProcessing] = useState(false)
  const [progress, setProgress] = useState('')
  const [outputUrl, setOutputUrl] = useState<string | null>(null)
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false)
  const ffmpegRef = useRef(new FFmpeg())
  const dragItem = useRef<number | null>(null)
  const dragOverItem = useRef<number | null>(null)

  const loadFfmpeg = useCallback(async () => {
    const ffmpeg = ffmpegRef.current
    if (ffmpegLoaded) return

    // Check SharedArrayBuffer support
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error('このブラウザはSharedArrayBufferをサポートしていません。Chrome/Edge/Firefoxの最新版をお使いください。')
    }

    setProgress('ffmpegを読み込み中...')

    ffmpeg.on('log', ({ message }) => {
      console.log('[ffmpeg]', message)
    })

    // Use jsdelivr CDN which is more reliable
    const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm'
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    })

    setFfmpegLoaded(true)
    setProgress('')
  }, [ffmpegLoaded])

  const getVideoDuration = (file: File): Promise<number> => {
    return new Promise((resolve) => {
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.onloadedmetadata = () => {
        URL.revokeObjectURL(video.src)
        resolve(video.duration)
      }
      video.src = URL.createObjectURL(file)
    })
  }

  const getVideoThumbnail = (file: File): Promise<string> => {
    return new Promise((resolve) => {
      const video = document.createElement('video')
      const canvas = document.createElement('canvas')
      video.preload = 'metadata'
      video.onloadeddata = () => {
        video.currentTime = 0.5
      }
      video.onseeked = () => {
        canvas.width = 120
        canvas.height = 68
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        URL.revokeObjectURL(video.src)
        resolve(canvas.toDataURL())
      }
      video.src = URL.createObjectURL(file)
    })
  }

  const extractNumber = (filename: string): number => {
    const match = filename.match(/^(\d+)/)
    return match ? parseInt(match[1], 10) : Infinity
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return

    setProgress('動画を読み込み中...')

    const videoFiles: VideoFile[] = await Promise.all(
      files.map(async (file) => ({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        duration: await getVideoDuration(file),
        thumbnail: await getVideoThumbnail(file),
      }))
    )

    // Sort by number prefix
    videoFiles.sort((a, b) => extractNumber(a.name) - extractNumber(b.name))

    setVideos(videoFiles)
    setProgress('')
    setOutputUrl(null)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('video/'))
    if (files.length === 0) return

    setProgress('動画を読み込み中...')

    const videoFiles: VideoFile[] = await Promise.all(
      files.map(async (file) => ({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        duration: await getVideoDuration(file),
        thumbnail: await getVideoThumbnail(file),
      }))
    )

    videoFiles.sort((a, b) => extractNumber(a.name) - extractNumber(b.name))

    setVideos(videoFiles)
    setProgress('')
    setOutputUrl(null)
  }

  const handleDragStart = (index: number) => {
    dragItem.current = index
  }

  const handleDragEnter = (index: number) => {
    dragOverItem.current = index
  }

  const handleDragEnd = () => {
    if (dragItem.current === null || dragOverItem.current === null) return

    const newVideos = [...videos]
    const draggedItem = newVideos[dragItem.current]
    newVideos.splice(dragItem.current, 1)
    newVideos.splice(dragOverItem.current, 0, draggedItem)

    dragItem.current = null
    dragOverItem.current = null
    setVideos(newVideos)
    setOutputUrl(null)
  }

  const removeVideo = (id: string) => {
    setVideos(videos.filter(v => v.id !== id))
    setOutputUrl(null)
  }

  const processVideos = async () => {
    if (videos.length < 2) {
      alert('2つ以上の動画を追加してください')
      return
    }

    setIsProcessing(true)
    setOutputUrl(null)

    try {
      await loadFfmpeg()
      const ffmpeg = ffmpegRef.current

      // Write all input files
      setProgress('ファイルを準備中...')
      for (let i = 0; i < videos.length; i++) {
        const data = await fetchFile(videos[i].file)
        await ffmpeg.writeFile(`input${i}.mp4`, data)
      }

      // Build filter complex for fade transitions
      const fadeFrames = Math.round(fadeDuration * 30) // Assuming 30fps
      const fadeOutFrames = Math.ceil(fadeFrames / 2)
      const fadeInFrames = Math.floor(fadeFrames / 2)

      let filterComplex = ''
      let inputs = ''

      // Input references
      for (let i = 0; i < videos.length; i++) {
        inputs += `-i input${i}.mp4 `
      }

      // Create filter graph
      // Each video: fade in (except first), fade out (except last)
      for (let i = 0; i < videos.length; i++) {
        const duration = videos[i].duration
        const isFirst = i === 0
        const isLast = i === videos.length - 1

        let videoFilter = `[${i}:v]`
        const filters: string[] = []

        if (!isFirst) {
          filters.push(`fade=t=in:st=0:d=${fadeInFrames / 30}`)
        }
        if (!isLast) {
          const fadeOutStart = duration - (fadeOutFrames / 30)
          filters.push(`fade=t=out:st=${fadeOutStart}:d=${fadeOutFrames / 30}`)
        }

        if (filters.length > 0) {
          videoFilter += `${filters.join(',')}[v${i}]`
        } else {
          videoFilter += `copy[v${i}]`
        }

        filterComplex += videoFilter + '; '
      }

      // Concatenate all videos
      let concatInput = ''
      for (let i = 0; i < videos.length; i++) {
        concatInput += `[v${i}][${i}:a]`
      }
      filterComplex += `${concatInput}concat=n=${videos.length}:v=1:a=1[outv][outa]`

      setProgress('動画を結合中... 0%')

      // Build ffmpeg command
      const args = inputs.trim().split(' ')
      args.push('-filter_complex', filterComplex)
      args.push('-map', '[outv]', '-map', '[outa]')
      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23')
      args.push('-c:a', 'aac', '-b:a', '128k')
      args.push('output.mp4')

      // Set up progress handler based on time
      const onProgress = ({ time }: { time: number; progress: number }) => {
        // time is in microseconds
        const currentSeconds = time / 1000000
        const percent = Math.min(99, Math.max(0, Math.round((currentSeconds / totalDuration) * 100)))
        setProgress(`動画を結合中... ${percent}%`)
      }
      ffmpeg.on('progress', onProgress)

      console.log('FFmpeg args:', args)
      const exitCode = await ffmpeg.exec(args)
      console.log('FFmpeg exit code:', exitCode)

      ffmpeg.off('progress', onProgress)

      if (exitCode !== 0) {
        throw new Error(`FFmpeg exited with code ${exitCode}`)
      }

      setProgress('ファイルを読み込み中...')

      // Read output file
      const data = await ffmpeg.readFile('output.mp4')
      console.log('Output file size:', (data as Uint8Array).length)
      const blob = new Blob([data as BlobPart], { type: 'video/mp4' })
      const url = URL.createObjectURL(blob)

      setOutputUrl(url)
      setProgress('')

      // Cleanup
      for (let i = 0; i < videos.length; i++) {
        await ffmpeg.deleteFile(`input${i}.mp4`)
      }
      await ffmpeg.deleteFile('output.mp4')

    } catch (error) {
      console.error('Error processing videos:', error)
      setProgress(`エラー: ${error}`)
    } finally {
      setIsProcessing(false)
    }
  }

  const totalDuration = videos.reduce((sum, v) => sum + v.duration, 0)

  return (
    <div className="app">
      <h1>動画結合アプリ</h1>
      <p className="subtitle">複数の動画を番号順に結合し、黒フェードでつなぎます</p>

      <div
        className="drop-zone"
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        <input
          type="file"
          accept="video/*"
          multiple
          onChange={handleFileSelect}
          id="file-input"
          style={{ display: 'none' }}
        />
        <label htmlFor="file-input" className="drop-label">
          <span className="drop-icon">📁</span>
          <span>動画ファイルをドラッグ&ドロップ</span>
          <span className="drop-hint">またはクリックして選択</span>
        </label>
      </div>

      {videos.length > 0 && (
        <>
          <div className="video-list">
            <h2>動画リスト（ドラッグで並び替え可能）</h2>
            {videos.map((video, index) => (
              <div
                key={video.id}
                className="video-item"
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragEnter={() => handleDragEnter(index)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => e.preventDefault()}
              >
                <span className="video-number">{index + 1}</span>
                <img src={video.thumbnail} alt="" className="video-thumbnail" />
                <div className="video-info">
                  <span className="video-name">{video.name}</span>
                  <span className="video-duration">{video.duration.toFixed(1)}秒</span>
                </div>
                <button className="remove-btn" onClick={() => removeVideo(video.id)}>✕</button>
              </div>
            ))}
          </div>

          <div className="settings">
            <label>
              フェード時間（合計）:
              <input
                type="number"
                value={fadeDuration}
                onChange={(e) => setFadeDuration(parseFloat(e.target.value) || 1.5)}
                min="0.5"
                max="5"
                step="0.1"
              />
              秒
            </label>
            <p className="info">
              動画{videos.length}本 / 合計 {totalDuration.toFixed(1)}秒
            </p>
          </div>

          <button
            className="process-btn"
            onClick={processVideos}
            disabled={isProcessing || videos.length < 2}
          >
            {isProcessing ? '処理中...' : '動画を結合する'}
          </button>
        </>
      )}

      {progress && <p className="progress">{progress}</p>}

      {outputUrl && (
        <div className="output">
          <h2>完成した動画</h2>
          <video src={outputUrl} controls className="output-video" />
          <a href={outputUrl} download="merged_video.mp4" className="download-btn">
            ダウンロード
          </a>
        </div>
      )}
    </div>
  )
}

export default App
