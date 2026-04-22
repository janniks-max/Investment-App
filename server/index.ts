import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'

// Import DB first — bootstraps all tables before any route fires
import './db.js'

import { stockRouter }        from './routes/stock.js'
import { fundamentalsRouter } from './routes/fundamentals.js'
import { signalsRouter }      from './routes/signals.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app  = express()
const PORT = parseInt(process.env.PORT ?? '3001', 10)

app.use(cors())
app.use(express.json())

app.use(stockRouter)
app.use(fundamentalsRouter)
app.use(signalsRouter)

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() })
)

// Serve Vite build in production
if (process.env.NODE_ENV === 'production') {
  const dist = path.join(__dirname, '../dist')
  app.use(express.static(dist))
  app.get('*', (_req, res) =>
    res.sendFile(path.join(dist, 'index.html'))
  )
}

app.listen(PORT, () => console.log(`STOCKPULSE server on :${PORT}`))
