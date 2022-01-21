import { serve } from 'server'
import { graphql, shortcut } from './api.ts'

// routes
const GQL = new URLPattern({pathname: '/graphql'})
const INDEX = new URLPattern({pathname: '/'})
const GOTO = new URLPattern({pathname: '/:code'})

serve(async (req: Request) => {
  if (GQL.test(req.url)) {
    return graphql(req)
  }
  
  if (INDEX.test(req.url)) {
    return new Response(`<h1>URL Shortener App</h1>`, {
      headers: {
        'Content-Type': 'text/html'
      }
    })
  }

  if (GOTO.test(req.url)) {
    const code = GOTO.exec(req.url)?.pathname?.groups?.code
    if (code) {
      return Response.redirect(await shortcut(code))
    }
  }

  return new Response('Not Found!', { status: 404})
})