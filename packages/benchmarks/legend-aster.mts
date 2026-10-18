import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
writeFileSync('.tmp-iso/legend.html', '<!doctype html><html><body><script src="./bundle3.js"></script></body></html>')
