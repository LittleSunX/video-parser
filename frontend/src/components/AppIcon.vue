<script setup lang="ts">
const paths = {
  link: [
    'M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-1.7 1.7',
    'M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  ],
  arrow: ['M7 17 17 7', 'M7 7h10v10'],
  download: ['M12 3v12', 'm7 10 5 5 5-5', 'M5 16v5h14v-5'],
  image: ['M3 3h18v18H3z', 'm3 16 6-6 12 11', 'm14 14 3-3 4 4', 'M15 7h.01'],
  grid: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
  live: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  expand: [
    'M8 3H3v5',
    'm3 3 6 6',
    'M16 3h5v5',
    'm21 3-6 6',
    'M3 16v5h5',
    'm3 21 6-6',
    'M21 16v5h-5',
    'm21 21-6-6',
  ],
  left: ['m14 6-6 6 6 6'],
  right: ['m10 6 6 6-6 6'],
  close: ['m6 6 12 12', 'M6 18 18 6'],
  music: ['M9 18V5l12-2v13', 'M9 18a3 3 0 1 1-3-3h3', 'M21 16a3 3 0 1 1-3-3h3'],
  film: ['M4 3h16v18H4z', 'M8 3v18', 'M16 3v18', 'M4 8h4', 'M4 16h4', 'M16 8h4', 'M16 16h4'],
  copy: ['M9 9h12v12H9z', 'M5 15H3V3h12v2'],
  check: ['m5 12 4 4L19 6'],
} as const

defineProps<{ name: keyof typeof paths }>()
</script>

<template>
  <svg
    class="app-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(path, index) in paths[name]" :key="index" :d="path" />
  </svg>
</template>
