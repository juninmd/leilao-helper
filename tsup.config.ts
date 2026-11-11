import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync } from 'fs';

export default defineConfig({
  entry: ['src/content_script.ts', 'src/popup.ts', 'src/background.ts'],
  outDir: 'dist',
  format: ['iife'],
  noExternal: [/.*/],
  clean: true,
  minify: false,
  onSuccess: async () => {
    mkdirSync('dist', { recursive: true });
    copyFileSync('src/styles.css', 'dist/styles.css');
    copyFileSync('src/popup.html', 'dist/popup.html');
    console.log('Copied styles.css → dist/styles.css');
    console.log('Copied popup.html → dist/popup.html');
  },
});
