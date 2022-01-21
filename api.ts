import "dotenv"
import { GraphQLHTTP } from 'gql'
import { makeExecutableSchema } from 'graphql_tools'
import { gql } from 'graphql_tag'
import { connect } from 'hyper-connect'

const hyper = connect(Deno.env.get('HYPER') as string)

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
`
interface Input {
  code: string
}
interface Shortcut {
  code: string
  href: string
}


const resolvers = {
  Query: {
    shortcut: async (_parent: unknown, { code } : Input) =>
      await hyper.data.get(code) as Shortcut
  },
  Mutation: {
    createShortcut(_parent: unknown, { code, href } : Shortcut) {
      return hyper.data.add({_id: code, code, href })
    }
  }
}

export const graphql = async (req: Request) =>
  await GraphQLHTTP({
    schema: makeExecutableSchema({resolvers, typeDefs}),
    graphiql: true
  })(req)

export const shortcut = async (code: string) => {
  const result = await hyper.data.get<Shortcut>(code) as Shortcut
  return result?.href
}
