# URL Shortner App

## Intro

- Meet Deno

Deno is a typescript/javascript runtime that strives for browser and standards
compatbility

- In the box

Dev Tools, like Debuging, Formatting, Linting, Type checking, Testing, Document
Generation, Bundling, and Compiling are built into Deno!

- Deploy on the Edge, https://deno.com is an edge distribution service that
  distributes your application as close to the user as possible around the
  world.

## Learn by doing

💪 Lets learn more by doing, we will create a simple URL shortner application
using Deno and deploy using Deno Deploy - 🦕

## Requirements

- Deno - https://deno.land/#installation

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

> import maps is an up and coming standard for js clients to control the
> behavior or imports, Deno has implemented the standard into their cli. To
> learn more about import maps read the following draft proposal
> https://wicg.github.io/import-maps/ and check out the Deno manual
> https://deno.land/manual/linking_to_external_code/import_maps

create a `Makefile` for our commands

```make
watch:
	@deno run --allow-env --allow-read --allow-net --import-map import_map.json --watch ./mod.ts
	
run:
	@deno run --allow-env --allow-read --allow-net --import-map import_map.json ./mod.ts

bundle:
	@deno bundle --import-map import_map.json ./mod.ts bundle.js

install:
	@deno cache --lock mod_lock.json --lock-write --import-map import_map.json mod.ts
```

> Makefiles are like npm scripts, it allows you to quickly create simple script
> commands and invoke them by calling: `make` or `make bundle` - for more
> information check out https://odino.org/makefile-101/

## Creating a Server

```ts
import { serve } from "server";

serve((_req: Request): Response => new Response("Hello World"));
```

> mod.ts is the commonly used name for the entry point of a Deno application,
> but you do not have to use this convention if you prefer another entry point
> name. The serve method takes a handler function as input and the handler
> function takes a Request argument parameter and expects a Response or
> Promise<Response> in return. Both Request and Response are documented on MDN
> https://developer.mozilla.org/en-US/docs/Web/API/Request and
> https://developer.mozilla.org/en-US/docs/Web/API/Response

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
    shortcut: async (_parent: unknown, { code }: Input) =>
      await hyper.data.get(code) as Shortcut,
  },
  Mutation: {
    createShortcut(_parent: unknown, { code, href }: Shortcut) {
      return hyper.data.add({ _id: code, code, href });
    },
  },
};

export const graphql = async (req: Request) =>
  await GraphQLHTTP({
    schema: makeExecutableSchema({ resolvers, typeDefs }),
    graphiql: true,
  })(req);
```

> The gql module provides a `GraphQLHTTP` method that takes an object with an
> executable schema, which includes resolvers and typeDefs and an option to show
> the graphiql ux, then returns a function matching the http handler criteria.

update `mod.ts` to import `api.ts`

```ts
import { serve } from "server";
import { graphql } from "./api.ts";

serve(graphql);
```

> We can run our graphql endpoint by importing graphql from the api module and
> adding it as an argument to our serve function. If you now run `make` you
> should spin up a graphql server.

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

> Using `URLPattern` we can setup our routes and use the test function to check
> if the incoming url matches the route we need for our handlers. This may not
> look as pretty as `express` but it built in to Deno and `URLPattern` is a
> standard web API - https://developer.mozilla.org/en-US/docs/Web/API/URLPattern

## Look up the code and redirect

Lets add the lookup function in `api.ts`

```ts
export const shortcut = async (code: string) => {
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

> 🎉 Congrats! You have setup a simple URL Shortcut app!
>
> Hopefully, you can see the power of Deno and how leveraging Web APIs as a part
> of a server runtime can reduce complexity without adding to much manual code!
> If you do need a framework, you should check out https://nanojsx.io/

## Gitpod Setup

> This section covers the files you will need to setup, if you plan to use
> gitpod, you can also fork this repo as well.

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

## Deno Deploy

Login to deno.com and create a new project, select you repository and the
`bundle.js` file and click `deploy`

> Try it out with https://hoppscotch.io

Query Shortcut

POST {url}/graphql

```json
{
  "query": "query { shortcut(code: \"1234\") { href }}"
}
```

---

Create Shortcut

POST {url}/graphql

```json
{
  "query": "mutation { createShortcut(code: \"fb\", href: \"https://facebook.com\") { ok }}"
}
```

## Thank you

Thank you for taking the time to work through this workshop! I hope you found it
educational and fun at the same time! 🎉

Thank you to the Deno community and the Deno team for building and supporting
this technology! 🙏🏻
