/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Brand Icon Generator for VS Code / Electron Apps
 *
 * This script generates all required icon sizes and formats from a single source PNG.
 * It creates icons for Windows (.ico), macOS (.icns folder), and Linux (multiple .png sizes).
 *
 * Usage:
 *   node generate.js [source-png] [output-dir] [app-name]
 *
 * Example:
 *   node generate.js ../../resources/Summit-Tec-Clean.png ../../resources code
 *
 * Or use npm script:
 *   npm run generate:summit
 */

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

let pngToIco;
try {
	pngToIco = require('png-to-ico');
} catch (e) {
	console.warn('[WARN] png-to-ico not available, ICO generation will be skipped');
}

let png2icons;
try {
	png2icons = require('png2icons');
} catch (e) {
	console.warn('[WARN] png2icons not available, ICNS generation will be skipped');
}

// Configuration
const config = {
	// Windows ICO sizes (embedded in single .ico file)
	windowsIcoSizes: [16, 24, 32, 48, 64, 128, 256],

	// Windows tile sizes
	windowsTileSizes: [70, 150],

	// Linux PNG sizes
	linuxSizes: [16, 24, 32, 48, 64, 128, 256, 512, 1024],

	// macOS iconset sizes (base sizes, @2x variants auto-generated)
	macOsSizes: [16, 32, 64, 128, 256, 512],

	// Inno Setup installer image dimensions and DPI variants
	innoSetup: {
		big: { width: 164, height: 314 }, // Sidebar
		small: { width: 55, height: 55 },  // Header
		dpiVariants: [100, 125, 150, 175, 200, 225, 250]
	}
};

/**
 * Ensure a directory exists
 */
function ensureDir(dirPath) {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
		console.log(`[DIR] Created directory: ${dirPath}`);
	}
}

/**
 * Load and resize image to specified size
 */
async function resizeImage(sourceImage, width, height = width) {
	const resized = sourceImage.clone();
	resized.contain(width, height, Jimp.HORIZONTAL_ALIGN_CENTER | Jimp.VERTICAL_ALIGN_MIDDLE);
	return resized;
}

/**
 * Save image as PNG
 */
async function savePng(image, outputPath) {
	await image.writeAsync(outputPath);
	console.log(`  [OK] Generated: ${path.basename(outputPath)}`);
}

/**
 * Generate Windows ICO file from multiple PNG sizes
 */
async function generateWindowsIco(sourceImage, outputDir, appName) {
	if (!pngToIco) {
		console.log('  [SKIP] Skipping ICO generation (png-to-ico not installed)');
		return;
	}

	const tempDir = path.join(outputDir, '.temp-ico');
	ensureDir(tempDir);

	const pngFiles = [];

	// Generate all sizes needed for ICO
	for (const size of config.windowsIcoSizes) {
		const resized = await resizeImage(sourceImage, size);
		const pngPath = path.join(tempDir, `${size}.png`);
		await resized.writeAsync(pngPath);
		pngFiles.push(pngPath);
		console.log(`  [OK] Prepared: ${size}x${size} for ICO`);
	}

	// Generate ICO from PNGs
	try {
		const icoPath = path.join(outputDir, 'win32', `${appName}.ico`);
		const icoBuffer = await pngToIco(pngFiles);
		fs.writeFileSync(icoPath, icoBuffer);
		console.log(`  [OK] Generated: ${appName}.ico`);
	} catch (err) {
		console.error(`  [ERROR] Failed to generate ICO: ${err.message}`);
	}

	// Cleanup temp files
	for (const file of pngFiles) {
		fs.unlinkSync(file);
	}
	fs.rmdirSync(tempDir);
}

/**
 * Generate Windows tile PNGs
 */
async function generateWindowsTiles(sourceImage, outputDir, appName) {
	const win32Dir = path.join(outputDir, 'win32');
	ensureDir(win32Dir);

	for (const size of config.windowsTileSizes) {
		const resized = await resizeImage(sourceImage, size);
		const outputPath = path.join(win32Dir, `${appName}_${size}x${size}.png`);
		await savePng(resized, outputPath);
	}
}

/**
 * Generate Inno Setup installer BMPs
 * Note: Jimp can output BMP format
 */
async function generateInnoBmps(sourceImage, outputDir, bgColor = 0x1e1e1eff) {
	const win32Dir = path.join(outputDir, 'win32');
	ensureDir(win32Dir);

	for (const dpi of config.innoSetup.dpiVariants) {
		const scale = dpi / 100;

		// Big image (sidebar) - logo centered in tall sidebar
		const bigWidth = Math.round(config.innoSetup.big.width * scale);
		const bigHeight = Math.round(config.innoSetup.big.height * scale);
		const bigLogoSize = Math.round(Math.min(bigWidth * 0.8, bigHeight * 0.3));

		// Create background image
		const bigImage = new Jimp(bigWidth, bigHeight, bgColor);

		// Resize logo and composite onto background
		const bigLogo = await resizeImage(sourceImage, bigLogoSize);
		const bigX = Math.round((bigWidth - bigLogoSize) / 2);
		const bigY = Math.round((bigHeight - bigLogoSize) / 3);
		bigImage.composite(bigLogo, bigX, bigY);

		const bigPath = path.join(win32Dir, `inno-big-${dpi}.bmp`);
		await bigImage.writeAsync(bigPath);
		console.log(`  [OK] Generated: inno-big-${dpi}.bmp (${bigWidth}x${bigHeight})`);

		// Small image (header) - just the logo
		const smallWidth = Math.round(config.innoSetup.small.width * scale);
		const smallHeight = Math.round(config.innoSetup.small.height * scale);

		// Create background and composite logo
		const smallImage = new Jimp(smallWidth, smallHeight, bgColor);
		const smallLogo = await resizeImage(sourceImage, smallWidth, smallHeight);
		smallImage.composite(smallLogo, 0, 0);

		const smallPath = path.join(win32Dir, `inno-small-${dpi}.bmp`);
		await smallImage.writeAsync(smallPath);
		console.log(`  [OK] Generated: inno-small-${dpi}.bmp (${smallWidth}x${smallHeight})`);
	}
}

/**
 * Generate Linux PNGs
 */
async function generateLinuxPngs(sourceImage, outputDir, appName) {
	const linuxDir = path.join(outputDir, 'linux');
	ensureDir(linuxDir);

	// Main icon (1024x1024)
	const mainPath = path.join(linuxDir, `${appName}.png`);
	await savePng(sourceImage.clone(), mainPath);

	// Individual sizes
	for (const size of config.linuxSizes) {
		const resized = await resizeImage(sourceImage, size);
		const outputPath = path.join(linuxDir, `${appName}_${size}x${size}.png`);
		await savePng(resized, outputPath);
	}
}

/**
 * Generate macOS iconset folder (for use with iconutil)
 */
async function generateMacOsIconset(sourceImage, outputDir, appName) {
	const darwinDir = path.join(outputDir, 'darwin');
	const iconsetDir = path.join(darwinDir, `${appName}.iconset`);
	ensureDir(iconsetDir);

	for (const size of config.macOsSizes) {
		// Standard resolution
		const stdResized = await resizeImage(sourceImage, size);
		const stdPath = path.join(iconsetDir, `icon_${size}x${size}.png`);
		await savePng(stdResized, stdPath);

		// @2x (Retina) resolution
		const retinaSize = size * 2;
		if (retinaSize <= 1024) {
			const retinaResized = await resizeImage(sourceImage, retinaSize);
			const retinaPath = path.join(iconsetDir, `icon_${size}x${size}@2x.png`);
			await savePng(retinaResized, retinaPath);
		}
	}

	// 512@2x is 1024
	const largestResized = await resizeImage(sourceImage, 1024);
	const largestPath = path.join(iconsetDir, 'icon_512x512@2x.png');
	await savePng(largestResized, largestPath);

	console.log(`\n[INFO] macOS iconset created at: ${iconsetDir}`);

	// Generate .icns file if png2icons is available
	if (png2icons) {
		try {
			// Read source PNG as buffer
			const sourceBuffer = await sourceImage.getBufferAsync(Jimp.MIME_PNG);

			// Generate ICNS using png2icons
			const icnsBuffer = png2icons.createICNS(sourceBuffer, png2icons.BICUBIC2, 0);

			if (icnsBuffer) {
				const icnsPath = path.join(darwinDir, `${appName}.icns`);
				fs.writeFileSync(icnsPath, icnsBuffer);
				console.log(`  [OK] Generated: ${appName}.icns`);
			} else {
				throw new Error('Failed to create ICNS buffer');
			}
		} catch (err) {
			console.error(`  [ERROR] Failed to generate ICNS: ${err.message}`);
			console.log('   To convert iconset to .icns on macOS, run:');
			console.log(`   iconutil -c icns "${iconsetDir}" -o "${path.join(darwinDir, `${appName}.icns`)}"`);
		}
	} else {
		console.log('   To convert to .icns on macOS, run:');
		console.log(`   iconutil -c icns "${iconsetDir}" -o "${path.join(darwinDir, `${appName}.icns`)}"`);
	}

	return iconsetDir;
}

/**
 * Generate all brand assets
 */
async function generateBrandAssets(sourcePath, outputDir, appName) {
	console.log('\n=== Brand Icon Generator ===\n');
	console.log(`Source: ${sourcePath}`);
	console.log(`Output: ${outputDir}`);
	console.log(`App Name: ${appName}\n`);

	// Validate source file
	if (!fs.existsSync(sourcePath)) {
		console.error(`[ERROR] Source file not found: ${sourcePath}`);
		process.exit(1);
	}

	// Load source image
	console.log('Loading source image...');
	const sourceImage = await Jimp.read(sourcePath);
	const { width, height } = sourceImage.bitmap;
	console.log(`Source image: ${width}x${height}\n`);

	if (width < 1024 || height < 1024) {
		console.warn('[WARN] Warning: Source image is smaller than 1024x1024.');
		console.warn('   For best results, use a 1024x1024 or larger PNG.\n');
	}

	// Ensure output directories
	ensureDir(path.join(outputDir, 'win32'));
	ensureDir(path.join(outputDir, 'darwin'));
	ensureDir(path.join(outputDir, 'linux'));

	// Generate Windows assets
	console.log('\n[Windows] Generating Windows assets...');
	await generateWindowsIco(sourceImage, outputDir, appName);
	await generateWindowsTiles(sourceImage, outputDir, appName);
	await generateInnoBmps(sourceImage, outputDir);

	// Generate Linux assets
	console.log('\n[Linux] Generating Linux assets...');
	await generateLinuxPngs(sourceImage, outputDir, appName);

	// Generate macOS assets
	console.log('\n[macOS] Generating macOS assets...');
	await generateMacOsIconset(sourceImage, outputDir, appName);

	console.log('\n[DONE] Brand asset generation complete!\n');

	// Print summary
	console.log('Generated assets:');
	console.log('-----------------');
	console.log(`  Windows: ${outputDir}/win32/`);
	console.log(`    - ${appName}.ico (multi-resolution)`);
	console.log(`    - ${appName}_70x70.png, ${appName}_150x150.png (tiles)`);
	console.log('    - inno-big-*.bmp, inno-small-*.bmp (installer images)');
	console.log(`  Linux: ${outputDir}/linux/`);
	console.log(`    - ${appName}.png and sized variants`);
	console.log(`  macOS: ${outputDir}/darwin/`);
	console.log(`    - ${appName}.iconset/ (use iconutil to create .icns)`);

	console.log('\nNext steps:');
	console.log('   1. Review generated assets');
	console.log('   2. On macOS, convert iconset to .icns:');
	console.log(`      iconutil -c icns resources/darwin/${appName}.iconset -o resources/darwin/${appName}.icns`);
	console.log('   3. Update build configuration to use new icon paths');
	console.log('   4. Or use a cross-platform tool like png2icns for .icns generation');
}

// CLI handling
const args = process.argv.slice(2);
const sourcePath = args[0] || path.join(__dirname, '..', '..', 'resources', 'Summit-Tec-Clean.png');
const outputDir = args[1] || path.join(__dirname, '..', '..', 'resources');
const appName = args[2] || 'code';

generateBrandAssets(
	path.resolve(sourcePath),
	path.resolve(outputDir),
	appName
).catch(err => {
	console.error('[ERROR] Error:', err.message);
	console.error(err.stack);
	process.exit(1);
});
