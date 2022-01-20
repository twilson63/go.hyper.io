# URL Shortner App

## Intro

## Setup

> If you have not already, create an account using https://dashboard.hyper.io
> and create an app called `username-go` or something unique and memorable.

create `.env` file

```
HYPER=[copy connection string from hyper app]
```

create `import_map.json` to add our dependencies

```json
{
  "imports": {
    "server": "https://deno.land/std@0.122.0/http/server.ts",
    "gql": "https://deno.land/x/gql@1.1.0/mod.ts",
    "graphql_tools": "https://deno.land/x/graphql_tools@0.0.2/mod.ts",
    "graphql_tag": "https://deno.land/x/graphql_tag@0.0.1/mod.ts",
    "hyper-connect": "https://x.nest.land/hyper-connect@0.1.10/deno/mod.ts",
    "dotenv": "https://deno.land/x/dotenv@v3.1.0/load.ts"
  }
}
```

create a `Makefile` for our commands

```make
watch:
	@deno run --allow-env --allow-read --allow-net --import-map import_map.json --watch ./mod.ts
	
run:
	@deno run --allow-env --allow-read --allow-net --import-map import_map.json ./mod.ts

bundle:
	@deno bundle --import-map import_map.json ./mod.ts bundle.ts
```

## Creating a Server

```ts
import { serve } from "server";

serve((_req: Request): Response => new Response("Hello World"));
```

## Create graphql API

create a file `api.ts`

```ts
import "dotenv";
import { GraphQLHTTP } from "gql";
import { makeExecutableSchema } from "graphql_tools";
import { gql } from "graphql_tag";
import { connect } from "hyper-connect";

const hyper = connect(Deno.env.get("HYPER") as string);

const typeDefs = gql`
  type Shortcut {
    code: String,
    href: String
  }

  type Result {
    ok: Boolean
  }

  type Query {
    shortcut(code: String!) : Shortcut
  }

  type Mutation {
    createShortcut(code: String, href: String) : Result!
  }
`;

interface Input {
  code: string;
}

interface Shortcut {
  code: string;
  href: string;
}

interface Result {
  ok: boolean;
}

const resolvers = {
  Query: {
    shortcut: async (_parent: unknown, { code }: Input): Promise<Shortcut> =>
      await hyper.data.get(code) as Shortcut,
  },
  Mutation: {
    createShortcut(
      _parent: unknown,
      { code, href }: Shortcut,
    ): Promise<Result> {
      return hyper.data.add({ _id: code, code, href });
    },
  },
};

export const graphql = (req: Request): Response =>
  GraphQLHTTP({
    schema: makeExecutableSchema({ resolvers, typeDefs }),
    graphiql: true,
  });
```

update `mod.ts` to import `api.ts`

```ts
import { serve } from "server";
import { graphql } from "./api.ts";

serve(graphql);
```

## Routing

Let's setup some routing for our server

```ts
import { serve } from "server";
import { graphql } from "./api.ts";

// routes
const GQL = new URLPattern({ pathname: "/graphql" });
const INDEX = new URLPattern({ pathname: "/" });
const GOTO = new URLPattern({ pathname: "/:code" });

serve((req: Request): Response => {
  if (GQL.test(req.url)) {
    return graphql(req);
  }
  if (INDEX.test(req.url)) {
    return new Response("URL Shortner App");
  }
  if (GOTO.test(req.url)) {
    return Response.redirect("https://google.com");
  }
  return new Response("Not Found", { status: 404 });
});
```

## Look up the code and redirect

Lets add the lookup function in `api.ts`

```ts
export const shortcut = async (code: string): Promise<string> => {
  let result = await hyper.data.get<Shortcut>(code) as Shortcut;
  return result.href;
};
```

Lets import shortcut in `mod.ts`

```ts
...
import { graphql, shortner } from './api.ts'
```

Lets modify the GOTO route handler to get shortcut

```ts
...
if (GOTO.exec(req.url)) {
  const code = GOTO.exec(req.url)?.pathname?.groups?.code;
  if (code) {
    return Response.redirect(await shortcut(code));
  }
}
...
```

## Gitpod Setup

`.gitpod.Dockerfile`

```Dockerfile
FROM gitpod/workspace-full
  
USER gitpod

# install deno
RUN curl -fsSL https://deno.land/x/install/install.sh | sh
RUN /home/gitpod/.deno/bin/deno completions bash > /home/gitpod/.bashrc.d/90-deno && echo 'export DENO_INSTALL="/home/gitpod/.deno"' >> /home/gitpod/.bashrc.d/90-deno &&     echo 'export PATH="$DENO_INSTALL/bin:$PATH"' >> /home/gitpod/.bashrc.d/90-deno
```

`.gitpod.yml`

```yaml
image:
  file: .gitpod.Dockerfile

tasks:
  - init: deno upgrade
  - command: export PS1=":) " && clear

ports:
  - port: 8000
    visibility: public
    onOpen: ignore
```

## VSCode Setup

`.vscode/settins.json`

```json
{
  "deno.enable": true,
  "deno.lint": true,
  "deno.unstable": true,
  "deno.importMap": "./import_map.json"
}
```
