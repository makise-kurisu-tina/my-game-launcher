/**
 * 从 build/icon.svg 生成 electron-builder 需要的多尺寸 icon.ico。
 * 由 package.json 的 predist / prepack 钩子在打包前自动调用，产物写入 build/icon-convert/。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = path.join(root, 'build', 'icon.svg');
const outputDir = path.join(root, 'build', 'icon-convert');
const outputFile = path.join(outputDir, 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  let svg;
  try {
    svg = await readFile(sourceFile);
  } catch {
    throw new Error(`找不到源图标：${path.relative(root, sourceFile)}`);
  }

  await mkdir(outputDir, { recursive: true });

  const frames = [];
  for (const size of SIZES) {
    frames.push(
      await sharp(svg, { density: 512 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer(),
    );
  }

  await writeFile(outputFile, await pngToIco(frames));
  console.log(`已生成图标 ${path.relative(root, outputFile)}（${SIZES.join(', ')}px）`);
}

main().catch((error) => {
  console.error(`生成图标失败：${error.message}`);
  process.exit(1);
});
