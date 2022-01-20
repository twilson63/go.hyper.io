import { serve } from "server";
import { graphql, shortcut } from "./api.ts";

// routes
const GQL = new URLPattern({ pathname: "/graphql" });
const INDEX = new URLPattern({ pathname: "/" });
const GOTO = new URLPattern({ pathname: "/:code" });

serve(async (req: Request): Promise<Response> => {
  if (GQL.exec(req.url)) {
    return await graphql(req);
  }
  if (INDEX.exec(req.url)) {
    return new Response("URL Shortner App");
  }
  if (GOTO.exec(req.url)) {
    const code = GOTO.exec(req.url)?.pathname?.groups?.code
    if (code) { 
      return Response.redirect(await shortcut(code));
    }
  }
  return new Response("Not Found", { status: 404 });
});