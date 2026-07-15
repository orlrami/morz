import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RESOURCES = join(ROOT, 'resources')
const APP_ICON_SOURCE = join(
  RESOURCES,
  'brand',
  '02-App-Icons',
  'morz-app-icon-dark.svg'
)
const FAVICON_SOURCE = join(
  RESOURCES,
  'brand',
  '03-Favicons',
  'morz-favicon.svg'
)

const APP_SIZES = [16, 20, 24, 32, 48, 64, 128, 256, 512, 1024]
const ICO_SIZES = [16, 24, 32, 48, 256]
const MASTER_SIZE = 2048

// Modern ICNS files store PNG payloads. Retina aliases intentionally repeat
// dimensions under distinct type codes so Finder can select the correct scale.
const ICNS_ENTRIES = [
  ['icp4', 16],
  ['ic11', 32],
  ['icp5', 32],
  ['ic12', 64],
  ['icp6', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024]
]

async function renderMaster(svgPath) {
  const svg = await readFile(svgPath)
  return sharp(svg, { density: 288 })
    .resize(MASTER_SIZE, MASTER_SIZE, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer()
}

async function renderSizes(master, sizes) {
  return new Map(
    await Promise.all(
      sizes.map(async (size) => [
        size,
        await sharp(master)
          .resize(size, size, {
            fit: 'contain',
            kernel: sharp.kernel.lanczos3,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .png({ compressionLevel: 9, adaptiveFiltering: true })
          .toBuffer()
      ])
    )
  )
}

function createIco(images, sizes) {
  const headerSize = 6
  const directoryEntrySize = 16
  let imageOffset = headerSize + directoryEntrySize * sizes.length

  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)

  const directory = Buffer.alloc(directoryEntrySize * sizes.length)
  const payloads = sizes.map((size, index) => {
    const image = images.get(size)
    if (!image) throw new Error(`Missing ${size}px ICO image`)

    const offset = index * directoryEntrySize
    directory.writeUInt8(size === 256 ? 0 : size, offset)
    directory.writeUInt8(size === 256 ? 0 : size, offset + 1)
    directory.writeUInt8(0, offset + 2)
    directory.writeUInt8(0, offset + 3)
    directory.writeUInt16LE(1, offset + 4)
    directory.writeUInt16LE(32, offset + 6)
    directory.writeUInt32LE(image.length, offset + 8)
    directory.writeUInt32LE(imageOffset, offset + 12)
    imageOffset += image.length
    return image
  })

  return Buffer.concat([header, directory, ...payloads])
}

function createIcns(images) {
  const chunks = ICNS_ENTRIES.map(([type, size]) => {
    const image = images.get(size)
    if (!image) throw new Error(`Missing ${size}px ICNS image`)

    const chunk = Buffer.alloc(8 + image.length)
    chunk.write(type, 0, 4, 'ascii')
    chunk.writeUInt32BE(chunk.length, 4)
    image.copy(chunk, 8)
    return chunk
  })

  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(header.length + body.length, 4)
  return Buffer.concat([header, body])
}

async function assertGoldPointSurvives(png, label) {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  let goldPixels = 0
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const [red, green, blue, alpha] = data.subarray(offset, offset + 4)
    if (alpha > 64 && red > green + 10 && green > blue + 10) {
      goldPixels += 1
    }
  }

  if (goldPixels === 0) {
    throw new Error(`${label}: gold point disappeared at 16px`)
  }

  return goldPixels
}

async function writeAtomic(path, contents) {
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, contents)
  await rm(path, { force: true })
  await rename(temporaryPath, path)
}

async function main() {
  const [appMaster, faviconMaster] = await Promise.all([
    renderMaster(APP_ICON_SOURCE),
    renderMaster(FAVICON_SOURCE)
  ])
  const [appImages, faviconImages] = await Promise.all([
    renderSizes(appMaster, APP_SIZES),
    renderSizes(faviconMaster, ICO_SIZES)
  ])

  const appGoldPixels = await assertGoldPointSurvives(
    appImages.get(16),
    'App icon'
  )
  const faviconGoldPixels = await assertGoldPointSurvives(
    faviconImages.get(16),
    'Favicon'
  )

  await Promise.all([
    writeAtomic(join(RESOURCES, 'icon.png'), appImages.get(512)),
    writeAtomic(join(RESOURCES, 'icon.ico'), createIco(appImages, ICO_SIZES)),
    writeAtomic(join(RESOURCES, 'icon.icns'), createIcns(appImages)),
    writeAtomic(
      join(RESOURCES, 'favicon.ico'),
      createIco(faviconImages, ICO_SIZES)
    )
  ])

  console.log(`Rendered app PNG sizes: ${APP_SIZES.join(', ')}`)
  console.log(`Packed ICO sizes: ${ICO_SIZES.join(', ')}`)
  console.log(
    `Packed ICNS sizes: ${[...new Set(ICNS_ENTRIES.map(([, size]) => size))].join(', ')}`
  )
  console.log(
    `16px gold-point check: app=${appGoldPixels} pixel(s), favicon=${faviconGoldPixels} pixel(s)`
  )
}

await main()
