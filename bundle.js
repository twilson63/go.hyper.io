function delay(ms, options = {}) {
    const { signal  } = options;
    if (signal?.aborted) {
        return Promise.reject(new DOMException("Delay was aborted.", "AbortError"));
    }
    return new Promise((resolve, reject1)=>{
        const abort = ()=>{
            clearTimeout(i2);
            reject1(new DOMException("Delay was aborted.", "AbortError"));
        };
        const done = ()=>{
            signal?.removeEventListener("abort", abort);
            resolve();
        };
        const i2 = setTimeout(done, ms);
        signal?.addEventListener("abort", abort, {
            once: true
        });
    });
}
const ERROR_SERVER_CLOSED = "Server closed";
const INITIAL_ACCEPT_BACKOFF_DELAY = 5;
const MAX_ACCEPT_BACKOFF_DELAY = 1000;
class Server {
    #port;
    #host;
    #handler;
    #closed = false;
    #listeners = new Set();
    #httpConnections = new Set();
    #onError;
    constructor(serverInit){
        this.#port = serverInit.port;
        this.#host = serverInit.hostname;
        this.#handler = serverInit.handler;
        this.#onError = serverInit.onError ?? function(error) {
            console.error(error);
            return new Response("Internal Server Error", {
                status: 500
            });
        };
    }
    async serve(listener) {
        if (this.#closed) {
            throw new Deno.errors.Http(ERROR_SERVER_CLOSED);
        }
        this.#trackListener(listener);
        try {
            return await this.#accept(listener);
        } finally{
            this.#untrackListener(listener);
            try {
                listener.close();
            } catch  {}
        }
    }
    async listenAndServe() {
        if (this.#closed) {
            throw new Deno.errors.Http(ERROR_SERVER_CLOSED);
        }
        const listener = Deno.listen({
            port: this.#port ?? 80,
            hostname: this.#host ?? "0.0.0.0",
            transport: "tcp"
        });
        return await this.serve(listener);
    }
    async listenAndServeTls(certFile, keyFile) {
        if (this.#closed) {
            throw new Deno.errors.Http(ERROR_SERVER_CLOSED);
        }
        const listener = Deno.listenTls({
            port: this.#port ?? 443,
            hostname: this.#host ?? "0.0.0.0",
            certFile,
            keyFile,
            transport: "tcp"
        });
        return await this.serve(listener);
    }
    close() {
        if (this.#closed) {
            throw new Deno.errors.Http(ERROR_SERVER_CLOSED);
        }
        this.#closed = true;
        for (const listener of this.#listeners){
            try {
                listener.close();
            } catch  {}
        }
        this.#listeners.clear();
        for (const httpConn of this.#httpConnections){
            this.#closeHttpConn(httpConn);
        }
        this.#httpConnections.clear();
    }
    get closed() {
        return this.#closed;
    }
    get addrs() {
        return Array.from(this.#listeners).map((listener)=>listener.addr
        );
    }
    async #respond(requestEvent, httpConn, connInfo) {
        let response;
        try {
            response = await this.#handler(requestEvent.request, connInfo);
        } catch (error) {
            response = await this.#onError(error);
        }
        try {
            await requestEvent.respondWith(response);
        } catch  {
            return this.#closeHttpConn(httpConn);
        }
    }
    async #serveHttp(httpConn1, connInfo1) {
        while(!this.#closed){
            let requestEvent;
            try {
                requestEvent = await httpConn1.nextRequest();
            } catch  {
                break;
            }
            if (requestEvent === null) {
                break;
            }
            this.#respond(requestEvent, httpConn1, connInfo1);
        }
        this.#closeHttpConn(httpConn1);
    }
    async #accept(listener) {
        let acceptBackoffDelay;
        while(!this.#closed){
            let conn;
            try {
                conn = await listener.accept();
            } catch (error) {
                if (error instanceof Deno.errors.BadResource || error instanceof Deno.errors.InvalidData || error instanceof Deno.errors.UnexpectedEof || error instanceof Deno.errors.ConnectionReset || error instanceof Deno.errors.NotConnected) {
                    if (!acceptBackoffDelay) {
                        acceptBackoffDelay = INITIAL_ACCEPT_BACKOFF_DELAY;
                    } else {
                        acceptBackoffDelay *= 2;
                    }
                    if (acceptBackoffDelay >= 1000) {
                        acceptBackoffDelay = MAX_ACCEPT_BACKOFF_DELAY;
                    }
                    await delay(acceptBackoffDelay);
                    continue;
                }
                throw error;
            }
            acceptBackoffDelay = undefined;
            let httpConn;
            try {
                httpConn = Deno.serveHttp(conn);
            } catch  {
                continue;
            }
            this.#trackHttpConnection(httpConn);
            const connInfo = {
                localAddr: conn.localAddr,
                remoteAddr: conn.remoteAddr
            };
            this.#serveHttp(httpConn, connInfo);
        }
    }
     #closeHttpConn(httpConn2) {
        this.#untrackHttpConnection(httpConn2);
        try {
            httpConn2.close();
        } catch  {}
    }
     #trackListener(listener1) {
        this.#listeners.add(listener1);
    }
     #untrackListener(listener2) {
        this.#listeners.delete(listener2);
    }
     #trackHttpConnection(httpConn3) {
        this.#httpConnections.add(httpConn3);
    }
     #untrackHttpConnection(httpConn4) {
        this.#httpConnections.delete(httpConn4);
    }
}
async function serve(handler, options = {}) {
    const server = new Server({
        port: options.port ?? 8000,
        hostname: options.hostname ?? "0.0.0.0",
        handler,
        onError: options.onError
    });
    if (options?.signal) {
        options.signal.onabort = ()=>server.close()
        ;
    }
    return await server.listenAndServe();
}
function removeEmptyValues(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, value])=>{
        if (value === null) return false;
        if (value === undefined) return false;
        if (value === "") return false;
        return true;
    }));
}
function difference(arrA, arrB) {
    return arrA.filter((a)=>arrB.indexOf(a) < 0
    );
}
function parse(rawDotenv) {
    const env = {};
    for (const line of rawDotenv.split("\n")){
        if (!isVariableStart(line)) continue;
        const key = line.slice(0, line.indexOf("=")).trim();
        let value = line.slice(line.indexOf("=") + 1).trim();
        if (hasSingleQuotes(value)) {
            value = value.slice(1, -1);
        } else if (hasDoubleQuotes(value)) {
            value = value.slice(1, -1);
            value = expandNewlines(value);
        } else value = value.trim();
        env[key] = value;
    }
    return env;
}
const defaultConfigOptions = {
    path: `.env`,
    export: false,
    safe: false,
    example: `.env.example`,
    allowEmptyValues: false,
    defaults: `.env.defaults`
};
async function configAsync(options = {}) {
    const o1 = {
        ...defaultConfigOptions,
        ...options
    };
    const conf = await parseFileAsync(o1.path);
    if (o1.defaults) {
        const confDefaults = await parseFileAsync(o1.defaults);
        for(const key in confDefaults){
            if (!(key in conf)) {
                conf[key] = confDefaults[key];
            }
        }
    }
    if (o1.safe) {
        const confExample = await parseFileAsync(o1.example);
        assertSafe(conf, confExample, o1.allowEmptyValues);
    }
    if (o1.export) {
        for(const key in conf){
            if (Deno.env.get(key) !== undefined) continue;
            Deno.env.set(key, conf[key]);
        }
    }
    return conf;
}
async function parseFileAsync(filepath) {
    try {
        return parse(new TextDecoder("utf-8").decode(await Deno.readFile(filepath)));
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) return {};
        throw e;
    }
}
function isVariableStart(str) {
    return /^\s*[a-zA-Z_][a-zA-Z_0-9 ]*\s*=/.test(str);
}
function hasSingleQuotes(str) {
    return /^'([\s\S]*)'$/.test(str);
}
function hasDoubleQuotes(str) {
    return /^"([\s\S]*)"$/.test(str);
}
function expandNewlines(str) {
    return str.replaceAll("\\n", "\n");
}
function assertSafe(conf, confExample, allowEmptyValues) {
    const currentEnv = Deno.env.toObject();
    const confWithEnv = Object.assign({}, currentEnv, conf);
    const missing = difference(Object.keys(confExample), Object.keys(allowEmptyValues ? confWithEnv : removeEmptyValues(confWithEnv)));
    if (missing.length > 0) {
        const errorMessages = [
            `The following variables were defined in the example file but are not present in the environment:\n  ${missing.join(", ")}`,
            `Make sure to add them to your env file.`,
            !allowEmptyValues && `If you expect any of these variables to be empty, you can set the allowEmptyValues option to true.`, 
        ];
        throw new MissingEnvVarsError(errorMessages.filter(Boolean).join("\n\n"));
    }
}
class MissingEnvVarsError extends Error {
    constructor(message){
        super(message);
        this.name = "MissingEnvVarsError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
await configAsync({
    export: true
});
Object.freeze({
    major: 15,
    minor: 0,
    patch: 0,
    preReleaseTag: null
});
function isPromise(value) {
    return typeof value?.then === 'function';
}
const nodejsCustomInspectSymbol = typeof Symbol === 'function' && typeof Symbol.for === 'function' ? Symbol.for('nodejs.util.inspect.custom') : undefined;
function inspect(value) {
    return formatValue(value, []);
}
function formatValue(value, seenValues) {
    switch(typeof value){
        case 'string':
            return JSON.stringify(value);
        case 'function':
            return value.name ? `[function ${value.name}]` : '[function]';
        case 'object':
            if (value === null) {
                return 'null';
            }
            return formatObjectValue(value, seenValues);
        default:
            return String(value);
    }
}
function formatObjectValue(value, previouslySeenValues) {
    if (previouslySeenValues.indexOf(value) !== -1) {
        return '[Circular]';
    }
    const seenValues = [
        ...previouslySeenValues,
        value
    ];
    const customInspectFn = getCustomFn(value);
    if (customInspectFn !== undefined) {
        const customValue = customInspectFn.call(value);
        if (customValue !== value) {
            return typeof customValue === 'string' ? customValue : formatValue(customValue, seenValues);
        }
    } else if (Array.isArray(value)) {
        return formatArray(value, seenValues);
    }
    return formatObject(value, seenValues);
}
function formatObject(object, seenValues) {
    const keys1 = Object.keys(object);
    if (keys1.length === 0) {
        return '{}';
    }
    if (seenValues.length > 2) {
        return '[' + getObjectTag(object) + ']';
    }
    const properties = keys1.map((key)=>{
        const value = formatValue(object[key], seenValues);
        return key + ': ' + value;
    });
    return '{ ' + properties.join(', ') + ' }';
}
function formatArray(array, seenValues) {
    if (array.length === 0) {
        return '[]';
    }
    if (seenValues.length > 2) {
        return '[Array]';
    }
    const len = Math.min(10, array.length);
    const remaining = array.length - len;
    const items = [];
    for(let i3 = 0; i3 < len; ++i3){
        items.push(formatValue(array[i3], seenValues));
    }
    if (remaining === 1) {
        items.push('... 1 more item');
    } else if (remaining > 1) {
        items.push(`... ${remaining} more items`);
    }
    return '[' + items.join(', ') + ']';
}
function getCustomFn(object) {
    const customInspectFn = object[String(nodejsCustomInspectSymbol)];
    if (typeof customInspectFn === 'function') {
        return customInspectFn;
    }
    if (typeof object.inspect === 'function') {
        return object.inspect;
    }
}
function getObjectTag(object) {
    const tag = Object.prototype.toString.call(object).replace(/^\[object /, '').replace(/]$/, '');
    if (tag === 'Object' && typeof object.constructor === 'function') {
        const name = object.constructor.name;
        if (typeof name === 'string' && name !== '') {
            return name;
        }
    }
    return tag;
}
function devAssert(condition, message) {
    const booleanCondition = Boolean(condition);
    if (!booleanCondition) {
        throw new Error(message);
    }
}
function isObjectLike(value) {
    return typeof value == 'object' && value !== null;
}
const SYMBOL_ITERATOR = typeof Symbol === 'function' ? Symbol.iterator : '@@iterator';
typeof Symbol === 'function' ? Symbol.asyncIterator : '@@asyncIterator';
const SYMBOL_TO_STRING_TAG = typeof Symbol === 'function' ? Symbol.toStringTag : '@@toStringTag';
function getLocation(source, position) {
    const lineRegexp = /\r\n|[\n\r]/g;
    let line = 1;
    let column = position + 1;
    let match1;
    while((match1 = lineRegexp.exec(source.body)) && match1.index < position){
        line += 1;
        column = position + 1 - (match1.index + match1[0].length);
    }
    return {
        line,
        column
    };
}
function printLocation(location) {
    return printSourceLocation(location.source, getLocation(location.source, location.start));
}
function printSourceLocation(source, sourceLocation) {
    const firstLineColumnOffset = source.locationOffset.column - 1;
    const body = whitespace(firstLineColumnOffset) + source.body;
    const lineIndex = sourceLocation.line - 1;
    const lineOffset = source.locationOffset.line - 1;
    const lineNum = sourceLocation.line + lineOffset;
    const columnOffset = sourceLocation.line === 1 ? firstLineColumnOffset : 0;
    const columnNum = sourceLocation.column + columnOffset;
    const locationStr = `${source.name}:${lineNum}:${columnNum}\n`;
    const lines = body.split(/\r\n|[\n\r]/g);
    const locationLine = lines[lineIndex];
    if (locationLine.length > 120) {
        const subLineIndex = Math.floor(columnNum / 80);
        const subLineColumnNum = columnNum % 80;
        const subLines = [];
        for(let i4 = 0; i4 < locationLine.length; i4 += 80){
            subLines.push(locationLine.slice(i4, i4 + 80));
        }
        return locationStr + printPrefixedLines([
            [
                `${lineNum}`,
                subLines[0]
            ],
            ...subLines.slice(1, subLineIndex + 1).map((subLine)=>[
                    '',
                    subLine
                ]
            ),
            [
                ' ',
                whitespace(subLineColumnNum - 1) + '^'
            ],
            [
                '',
                subLines[subLineIndex + 1]
            ]
        ]);
    }
    return locationStr + printPrefixedLines([
        [
            `${lineNum - 1}`,
            lines[lineIndex - 1]
        ],
        [
            `${lineNum}`,
            locationLine
        ],
        [
            '',
            whitespace(columnNum - 1) + '^'
        ],
        [
            `${lineNum + 1}`,
            lines[lineIndex + 1]
        ]
    ]);
}
function printPrefixedLines(lines) {
    const existingLines = lines.filter(([_, line])=>line !== undefined
    );
    const padLen = Math.max(...existingLines.map(([prefix])=>prefix.length
    ));
    return existingLines.map(([prefix, line])=>leftPad(padLen, prefix) + (line ? ' | ' + line : ' |')
    ).join('\n');
}
function whitespace(len) {
    return Array(len + 1).join(' ');
}
function leftPad(len, str) {
    return whitespace(len - str.length) + str;
}
class GraphQLError extends Error {
    constructor(message, nodes, source, positions, path1, originalError, extensions){
        super(message);
        const _nodes = Array.isArray(nodes) ? nodes.length !== 0 ? nodes : undefined : nodes ? [
            nodes
        ] : undefined;
        let _source = source;
        if (!_source && _nodes) {
            _source = _nodes[0].loc?.source;
        }
        let _positions = positions;
        if (!_positions && _nodes) {
            _positions = _nodes.reduce((list1, node)=>{
                if (node.loc) {
                    list1.push(node.loc.start);
                }
                return list1;
            }, []);
        }
        if (_positions && _positions.length === 0) {
            _positions = undefined;
        }
        let _locations;
        if (positions && source) {
            _locations = positions.map((pos)=>getLocation(source, pos)
            );
        } else if (_nodes) {
            _locations = _nodes.reduce((list2, node)=>{
                if (node.loc) {
                    list2.push(getLocation(node.loc.source, node.loc.start));
                }
                return list2;
            }, []);
        }
        let _extensions = extensions;
        if (_extensions == null && originalError != null) {
            const originalExtensions = originalError.extensions;
            if (isObjectLike(originalExtensions)) {
                _extensions = originalExtensions;
            }
        }
        Object.defineProperties(this, {
            name: {
                value: 'GraphQLError'
            },
            message: {
                value: message,
                enumerable: true,
                writable: true
            },
            locations: {
                value: _locations ?? undefined,
                enumerable: _locations != null
            },
            path: {
                value: path1 ?? undefined,
                enumerable: path1 != null
            },
            nodes: {
                value: _nodes ?? undefined
            },
            source: {
                value: _source ?? undefined
            },
            positions: {
                value: _positions ?? undefined
            },
            originalError: {
                value: originalError
            },
            extensions: {
                value: _extensions ?? undefined,
                enumerable: _extensions != null
            }
        });
        if (originalError?.stack) {
            Object.defineProperty(this, 'stack', {
                value: originalError.stack,
                writable: true,
                configurable: true
            });
            return;
        }
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, GraphQLError);
        } else {
            Object.defineProperty(this, 'stack', {
                value: Error().stack,
                writable: true,
                configurable: true
            });
        }
    }
    toString() {
        return printError(this);
    }
    get [SYMBOL_TO_STRING_TAG]() {
        return 'Object';
    }
}
function printError(error) {
    let output = error.message;
    if (error.nodes) {
        for (const node of error.nodes){
            if (node.loc) {
                output += '\n\n' + printLocation(node.loc);
            }
        }
    } else if (error.source && error.locations) {
        for (const location of error.locations){
            output += '\n\n' + printSourceLocation(error.source, location);
        }
    }
    return output;
}
function syntaxError(source, position, description) {
    return new GraphQLError(`Syntax Error: ${description}`, undefined, source, [
        position
    ]);
}
const Kind = Object.freeze({
    NAME: 'Name',
    DOCUMENT: 'Document',
    OPERATION_DEFINITION: 'OperationDefinition',
    VARIABLE_DEFINITION: 'VariableDefinition',
    SELECTION_SET: 'SelectionSet',
    FIELD: 'Field',
    ARGUMENT: 'Argument',
    FRAGMENT_SPREAD: 'FragmentSpread',
    INLINE_FRAGMENT: 'InlineFragment',
    FRAGMENT_DEFINITION: 'FragmentDefinition',
    VARIABLE: 'Variable',
    INT: 'IntValue',
    FLOAT: 'FloatValue',
    STRING: 'StringValue',
    BOOLEAN: 'BooleanValue',
    NULL: 'NullValue',
    ENUM: 'EnumValue',
    LIST: 'ListValue',
    OBJECT: 'ObjectValue',
    OBJECT_FIELD: 'ObjectField',
    DIRECTIVE: 'Directive',
    NAMED_TYPE: 'NamedType',
    LIST_TYPE: 'ListType',
    NON_NULL_TYPE: 'NonNullType',
    SCHEMA_DEFINITION: 'SchemaDefinition',
    OPERATION_TYPE_DEFINITION: 'OperationTypeDefinition',
    SCALAR_TYPE_DEFINITION: 'ScalarTypeDefinition',
    OBJECT_TYPE_DEFINITION: 'ObjectTypeDefinition',
    FIELD_DEFINITION: 'FieldDefinition',
    INPUT_VALUE_DEFINITION: 'InputValueDefinition',
    INTERFACE_TYPE_DEFINITION: 'InterfaceTypeDefinition',
    UNION_TYPE_DEFINITION: 'UnionTypeDefinition',
    ENUM_TYPE_DEFINITION: 'EnumTypeDefinition',
    ENUM_VALUE_DEFINITION: 'EnumValueDefinition',
    INPUT_OBJECT_TYPE_DEFINITION: 'InputObjectTypeDefinition',
    DIRECTIVE_DEFINITION: 'DirectiveDefinition',
    SCHEMA_EXTENSION: 'SchemaExtension',
    SCALAR_TYPE_EXTENSION: 'ScalarTypeExtension',
    OBJECT_TYPE_EXTENSION: 'ObjectTypeExtension',
    INTERFACE_TYPE_EXTENSION: 'InterfaceTypeExtension',
    UNION_TYPE_EXTENSION: 'UnionTypeExtension',
    ENUM_TYPE_EXTENSION: 'EnumTypeExtension',
    INPUT_OBJECT_TYPE_EXTENSION: 'InputObjectTypeExtension'
});
class Source {
    constructor(body, name = 'GraphQL request', locationOffset = {
        line: 1,
        column: 1
    }){
        this.body = body;
        this.name = name;
        this.locationOffset = locationOffset;
        devAssert(this.locationOffset.line > 0, 'line in locationOffset is 1-indexed and must be positive.');
        devAssert(this.locationOffset.column > 0, 'column in locationOffset is 1-indexed and must be positive.');
    }
    get [SYMBOL_TO_STRING_TAG]() {
        return 'Source';
    }
}
const DirectiveLocation = Object.freeze({
    QUERY: 'QUERY',
    MUTATION: 'MUTATION',
    SUBSCRIPTION: 'SUBSCRIPTION',
    FIELD: 'FIELD',
    FRAGMENT_DEFINITION: 'FRAGMENT_DEFINITION',
    FRAGMENT_SPREAD: 'FRAGMENT_SPREAD',
    INLINE_FRAGMENT: 'INLINE_FRAGMENT',
    VARIABLE_DEFINITION: 'VARIABLE_DEFINITION',
    SCHEMA: 'SCHEMA',
    SCALAR: 'SCALAR',
    OBJECT: 'OBJECT',
    FIELD_DEFINITION: 'FIELD_DEFINITION',
    ARGUMENT_DEFINITION: 'ARGUMENT_DEFINITION',
    INTERFACE: 'INTERFACE',
    UNION: 'UNION',
    ENUM: 'ENUM',
    ENUM_VALUE: 'ENUM_VALUE',
    INPUT_OBJECT: 'INPUT_OBJECT',
    INPUT_FIELD_DEFINITION: 'INPUT_FIELD_DEFINITION'
});
const TokenKind = Object.freeze({
    SOF: '<SOF>',
    EOF: '<EOF>',
    BANG: '!',
    DOLLAR: '$',
    AMP: '&',
    PAREN_L: '(',
    PAREN_R: ')',
    SPREAD: '...',
    COLON: ':',
    EQUALS: '=',
    AT: '@',
    BRACKET_L: '[',
    BRACKET_R: ']',
    BRACE_L: '{',
    PIPE: '|',
    BRACE_R: '}',
    NAME: 'Name',
    INT: 'Int',
    FLOAT: 'Float',
    STRING: 'String',
    BLOCK_STRING: 'BlockString',
    COMMENT: 'Comment'
});
function defineToJSON(classObject, fn = classObject.prototype.toString) {
    classObject.prototype.toJSON = fn;
    classObject.prototype.inspect = fn;
    if (nodejsCustomInspectSymbol) {
        classObject.prototype[nodejsCustomInspectSymbol] = fn;
    }
}
class Location {
    constructor(startToken, endToken, source){
        this.start = startToken.start;
        this.end = endToken.end;
        this.startToken = startToken;
        this.endToken = endToken;
        this.source = source;
    }
}
defineToJSON(Location, function() {
    return {
        start: this.start,
        end: this.end
    };
});
class Token {
    constructor(kind, start, end, line, column, prev, value){
        this.kind = kind;
        this.start = start;
        this.end = end;
        this.line = line;
        this.column = column;
        this.value = value;
        this.prev = prev;
        this.next = null;
    }
}
defineToJSON(Token, function() {
    return {
        kind: this.kind,
        value: this.value,
        line: this.line,
        column: this.column
    };
});
function isNode(maybeNode) {
    return maybeNode != null && typeof maybeNode.kind === 'string';
}
function dedentBlockStringValue(rawString) {
    const lines = rawString.split(/\r\n|[\n\r]/g);
    const commonIndent = getBlockStringIndentation(lines);
    if (commonIndent !== 0) {
        for(let i5 = 1; i5 < lines.length; i5++){
            lines[i5] = lines[i5].slice(commonIndent);
        }
    }
    while(lines.length > 0 && isBlank(lines[0])){
        lines.shift();
    }
    while(lines.length > 0 && isBlank(lines[lines.length - 1])){
        lines.pop();
    }
    return lines.join('\n');
}
function getBlockStringIndentation(lines) {
    let commonIndent = null;
    for(let i6 = 1; i6 < lines.length; i6++){
        const line = lines[i6];
        const indent1 = leadingWhitespace(line);
        if (indent1 === line.length) {
            continue;
        }
        if (commonIndent === null || indent1 < commonIndent) {
            commonIndent = indent1;
            if (commonIndent === 0) {
                break;
            }
        }
    }
    return commonIndent === null ? 0 : commonIndent;
}
function leadingWhitespace(str) {
    let i7 = 0;
    while(i7 < str.length && (str[i7] === ' ' || str[i7] === '\t')){
        i7++;
    }
    return i7;
}
function isBlank(str) {
    return leadingWhitespace(str) === str.length;
}
function printBlockString(value, indentation = '', preferMultipleLines = false) {
    const isSingleLine = value.indexOf('\n') === -1;
    const hasLeadingSpace = value[0] === ' ' || value[0] === '\t';
    const hasTrailingQuote = value[value.length - 1] === '"';
    const printAsMultipleLines = !isSingleLine || hasTrailingQuote || preferMultipleLines;
    let result = '';
    if (printAsMultipleLines && !(isSingleLine && hasLeadingSpace)) {
        result += '\n' + indentation;
    }
    result += indentation ? value.replace(/\n/g, '\n' + indentation) : value;
    if (printAsMultipleLines) {
        result += '\n';
    }
    return '"""' + result.replace(/"""/g, '\\"""') + '"""';
}
class Lexer {
    constructor(source){
        const startOfFileToken = new Token(TokenKind.SOF, 0, 0, 0, 0, null);
        this.source = source;
        this.lastToken = startOfFileToken;
        this.token = startOfFileToken;
        this.line = 1;
        this.lineStart = 0;
    }
    advance() {
        this.lastToken = this.token;
        const token = this.token = this.lookahead();
        return token;
    }
    lookahead() {
        let token = this.token;
        if (token.kind !== TokenKind.EOF) {
            do {
                token = token.next ?? (token.next = readToken(this, token));
            }while (token.kind === TokenKind.COMMENT)
        }
        return token;
    }
}
function isPunctuatorTokenKind(kind) {
    return kind === TokenKind.BANG || kind === TokenKind.DOLLAR || kind === TokenKind.AMP || kind === TokenKind.PAREN_L || kind === TokenKind.PAREN_R || kind === TokenKind.SPREAD || kind === TokenKind.COLON || kind === TokenKind.EQUALS || kind === TokenKind.AT || kind === TokenKind.BRACKET_L || kind === TokenKind.BRACKET_R || kind === TokenKind.BRACE_L || kind === TokenKind.PIPE || kind === TokenKind.BRACE_R;
}
function printCharCode(code2) {
    return isNaN(code2) ? TokenKind.EOF : code2 < 127 ? JSON.stringify(String.fromCharCode(code2)) : `"\\u${('00' + code2.toString(16).toUpperCase()).slice(-4)}"`;
}
function readToken(lexer, prev) {
    const source = lexer.source;
    const body = source.body;
    const bodyLength = body.length;
    const pos = positionAfterWhitespace(body, prev.end, lexer);
    const line = lexer.line;
    const col = 1 + pos - lexer.lineStart;
    if (pos >= bodyLength) {
        return new Token(TokenKind.EOF, bodyLength, bodyLength, line, col, prev);
    }
    const code3 = body.charCodeAt(pos);
    switch(code3){
        case 33:
            return new Token(TokenKind.BANG, pos, pos + 1, line, col, prev);
        case 35:
            return readComment(source, pos, line, col, prev);
        case 36:
            return new Token(TokenKind.DOLLAR, pos, pos + 1, line, col, prev);
        case 38:
            return new Token(TokenKind.AMP, pos, pos + 1, line, col, prev);
        case 40:
            return new Token(TokenKind.PAREN_L, pos, pos + 1, line, col, prev);
        case 41:
            return new Token(TokenKind.PAREN_R, pos, pos + 1, line, col, prev);
        case 46:
            if (body.charCodeAt(pos + 1) === 46 && body.charCodeAt(pos + 2) === 46) {
                return new Token(TokenKind.SPREAD, pos, pos + 3, line, col, prev);
            }
            break;
        case 58:
            return new Token(TokenKind.COLON, pos, pos + 1, line, col, prev);
        case 61:
            return new Token(TokenKind.EQUALS, pos, pos + 1, line, col, prev);
        case 64:
            return new Token(TokenKind.AT, pos, pos + 1, line, col, prev);
        case 91:
            return new Token(TokenKind.BRACKET_L, pos, pos + 1, line, col, prev);
        case 93:
            return new Token(TokenKind.BRACKET_R, pos, pos + 1, line, col, prev);
        case 123:
            return new Token(TokenKind.BRACE_L, pos, pos + 1, line, col, prev);
        case 124:
            return new Token(TokenKind.PIPE, pos, pos + 1, line, col, prev);
        case 125:
            return new Token(TokenKind.BRACE_R, pos, pos + 1, line, col, prev);
        case 65:
        case 66:
        case 67:
        case 68:
        case 69:
        case 70:
        case 71:
        case 72:
        case 73:
        case 74:
        case 75:
        case 76:
        case 77:
        case 78:
        case 79:
        case 80:
        case 81:
        case 82:
        case 83:
        case 84:
        case 85:
        case 86:
        case 87:
        case 88:
        case 89:
        case 90:
        case 95:
        case 97:
        case 98:
        case 99:
        case 100:
        case 101:
        case 102:
        case 103:
        case 104:
        case 105:
        case 106:
        case 107:
        case 108:
        case 109:
        case 110:
        case 111:
        case 112:
        case 113:
        case 114:
        case 115:
        case 116:
        case 117:
        case 118:
        case 119:
        case 120:
        case 121:
        case 122:
            return readName(source, pos, line, col, prev);
        case 45:
        case 48:
        case 49:
        case 50:
        case 51:
        case 52:
        case 53:
        case 54:
        case 55:
        case 56:
        case 57:
            return readNumber(source, pos, code3, line, col, prev);
        case 34:
            if (body.charCodeAt(pos + 1) === 34 && body.charCodeAt(pos + 2) === 34) {
                return readBlockString(source, pos, line, col, prev, lexer);
            }
            return readString(source, pos, line, col, prev);
    }
    throw syntaxError(source, pos, unexpectedCharacterMessage(code3));
}
function unexpectedCharacterMessage(code4) {
    if (code4 < 32 && code4 !== 9 && code4 !== 10 && code4 !== 13) {
        return `Cannot contain the invalid character ${printCharCode(code4)}.`;
    }
    if (code4 === 39) {
        return 'Unexpected single quote character (\'), did you mean to use a double quote (")?';
    }
    return `Cannot parse the unexpected character ${printCharCode(code4)}.`;
}
function positionAfterWhitespace(body, startPosition, lexer) {
    const bodyLength = body.length;
    let position = startPosition;
    while(position < bodyLength){
        const code5 = body.charCodeAt(position);
        if (code5 === 9 || code5 === 32 || code5 === 44 || code5 === 65279) {
            ++position;
        } else if (code5 === 10) {
            ++position;
            ++lexer.line;
            lexer.lineStart = position;
        } else if (code5 === 13) {
            if (body.charCodeAt(position + 1) === 10) {
                position += 2;
            } else {
                ++position;
            }
            ++lexer.line;
            lexer.lineStart = position;
        } else {
            break;
        }
    }
    return position;
}
function readComment(source, start, line, col, prev) {
    const body = source.body;
    let code6;
    let position = start;
    do {
        code6 = body.charCodeAt(++position);
    }while (!isNaN(code6) && (code6 > 31 || code6 === 9))
    return new Token(TokenKind.COMMENT, start, position, line, col, prev, body.slice(start + 1, position));
}
function readNumber(source, start, firstCode, line, col, prev) {
    const body = source.body;
    let code7 = firstCode;
    let position = start;
    let isFloat = false;
    if (code7 === 45) {
        code7 = body.charCodeAt(++position);
    }
    if (code7 === 48) {
        code7 = body.charCodeAt(++position);
        if (code7 >= 48 && code7 <= 57) {
            throw syntaxError(source, position, `Invalid number, unexpected digit after 0: ${printCharCode(code7)}.`);
        }
    } else {
        position = readDigits(source, position, code7);
        code7 = body.charCodeAt(position);
    }
    if (code7 === 46) {
        isFloat = true;
        code7 = body.charCodeAt(++position);
        position = readDigits(source, position, code7);
        code7 = body.charCodeAt(position);
    }
    if (code7 === 69 || code7 === 101) {
        isFloat = true;
        code7 = body.charCodeAt(++position);
        if (code7 === 43 || code7 === 45) {
            code7 = body.charCodeAt(++position);
        }
        position = readDigits(source, position, code7);
        code7 = body.charCodeAt(position);
    }
    if (code7 === 46 || isNameStart(code7)) {
        throw syntaxError(source, position, `Invalid number, expected digit but got: ${printCharCode(code7)}.`);
    }
    return new Token(isFloat ? TokenKind.FLOAT : TokenKind.INT, start, position, line, col, prev, body.slice(start, position));
}
function readDigits(source, start, firstCode) {
    const body = source.body;
    let position = start;
    let code8 = firstCode;
    if (code8 >= 48 && code8 <= 57) {
        do {
            code8 = body.charCodeAt(++position);
        }while (code8 >= 48 && code8 <= 57)
        return position;
    }
    throw syntaxError(source, position, `Invalid number, expected digit but got: ${printCharCode(code8)}.`);
}
function readString(source, start, line, col, prev) {
    const body = source.body;
    let position = start + 1;
    let chunkStart = position;
    let code9 = 0;
    let value = '';
    while(position < body.length && !isNaN(code9 = body.charCodeAt(position)) && code9 !== 10 && code9 !== 13){
        if (code9 === 34) {
            value += body.slice(chunkStart, position);
            return new Token(TokenKind.STRING, start, position + 1, line, col, prev, value);
        }
        if (code9 < 32 && code9 !== 9) {
            throw syntaxError(source, position, `Invalid character within String: ${printCharCode(code9)}.`);
        }
        ++position;
        if (code9 === 92) {
            value += body.slice(chunkStart, position - 1);
            code9 = body.charCodeAt(position);
            switch(code9){
                case 34:
                    value += '"';
                    break;
                case 47:
                    value += '/';
                    break;
                case 92:
                    value += '\\';
                    break;
                case 98:
                    value += '\b';
                    break;
                case 102:
                    value += '\f';
                    break;
                case 110:
                    value += '\n';
                    break;
                case 114:
                    value += '\r';
                    break;
                case 116:
                    value += '\t';
                    break;
                case 117:
                    {
                        const charCode = uniCharCode(body.charCodeAt(position + 1), body.charCodeAt(position + 2), body.charCodeAt(position + 3), body.charCodeAt(position + 4));
                        if (charCode < 0) {
                            const invalidSequence = body.slice(position + 1, position + 5);
                            throw syntaxError(source, position, `Invalid character escape sequence: \\u${invalidSequence}.`);
                        }
                        value += String.fromCharCode(charCode);
                        position += 4;
                        break;
                    }
                default:
                    throw syntaxError(source, position, `Invalid character escape sequence: \\${String.fromCharCode(code9)}.`);
            }
            ++position;
            chunkStart = position;
        }
    }
    throw syntaxError(source, position, 'Unterminated string.');
}
function readBlockString(source, start, line, col, prev, lexer) {
    const body = source.body;
    let position = start + 3;
    let chunkStart = position;
    let code10 = 0;
    let rawValue = '';
    while(position < body.length && !isNaN(code10 = body.charCodeAt(position))){
        if (code10 === 34 && body.charCodeAt(position + 1) === 34 && body.charCodeAt(position + 2) === 34) {
            rawValue += body.slice(chunkStart, position);
            return new Token(TokenKind.BLOCK_STRING, start, position + 3, line, col, prev, dedentBlockStringValue(rawValue));
        }
        if (code10 < 32 && code10 !== 9 && code10 !== 10 && code10 !== 13) {
            throw syntaxError(source, position, `Invalid character within String: ${printCharCode(code10)}.`);
        }
        if (code10 === 10) {
            ++position;
            ++lexer.line;
            lexer.lineStart = position;
        } else if (code10 === 13) {
            if (body.charCodeAt(position + 1) === 10) {
                position += 2;
            } else {
                ++position;
            }
            ++lexer.line;
            lexer.lineStart = position;
        } else if (code10 === 92 && body.charCodeAt(position + 1) === 34 && body.charCodeAt(position + 2) === 34 && body.charCodeAt(position + 3) === 34) {
            rawValue += body.slice(chunkStart, position) + '"""';
            position += 4;
            chunkStart = position;
        } else {
            ++position;
        }
    }
    throw syntaxError(source, position, 'Unterminated string.');
}
function uniCharCode(a, b, c, d) {
    return char2hex(a) << 12 | char2hex(b) << 8 | char2hex(c) << 4 | char2hex(d);
}
function char2hex(a) {
    return a >= 48 && a <= 57 ? a - 48 : a >= 65 && a <= 70 ? a - 55 : a >= 97 && a <= 102 ? a - 87 : -1;
}
function readName(source, start, line, col, prev) {
    const body = source.body;
    const bodyLength = body.length;
    let position = start + 1;
    let code11 = 0;
    while(position !== bodyLength && !isNaN(code11 = body.charCodeAt(position)) && (code11 === 95 || code11 >= 48 && code11 <= 57 || code11 >= 65 && code11 <= 90 || code11 >= 97 && code11 <= 122)){
        ++position;
    }
    return new Token(TokenKind.NAME, start, position, line, col, prev, body.slice(start, position));
}
function isNameStart(code12) {
    return code12 === 95 || code12 >= 65 && code12 <= 90 || code12 >= 97 && code12 <= 122;
}
function parse1(source, options) {
    const parser = new Parser(source, options);
    return parser.parseDocument();
}
class Parser {
    constructor(source, options){
        const sourceObj = typeof source === 'string' ? new Source(source) : source;
        devAssert(sourceObj instanceof Source, `Must provide Source. Received: ${inspect(sourceObj)}.`);
        this._lexer = new Lexer(sourceObj);
        this._options = options;
    }
    parseName() {
        const token = this.expectToken(TokenKind.NAME);
        return {
            kind: Kind.NAME,
            value: token.value,
            loc: this.loc(token)
        };
    }
    parseDocument() {
        const start = this._lexer.token;
        return {
            kind: Kind.DOCUMENT,
            definitions: this.many(TokenKind.SOF, this.parseDefinition, TokenKind.EOF),
            loc: this.loc(start)
        };
    }
    parseDefinition() {
        if (this.peek(TokenKind.NAME)) {
            switch(this._lexer.token.value){
                case 'query':
                case 'mutation':
                case 'subscription':
                    return this.parseOperationDefinition();
                case 'fragment':
                    return this.parseFragmentDefinition();
                case 'schema':
                case 'scalar':
                case 'type':
                case 'interface':
                case 'union':
                case 'enum':
                case 'input':
                case 'directive':
                    return this.parseTypeSystemDefinition();
                case 'extend':
                    return this.parseTypeSystemExtension();
            }
        } else if (this.peek(TokenKind.BRACE_L)) {
            return this.parseOperationDefinition();
        } else if (this.peekDescription()) {
            return this.parseTypeSystemDefinition();
        }
        throw this.unexpected();
    }
    parseOperationDefinition() {
        const start = this._lexer.token;
        if (this.peek(TokenKind.BRACE_L)) {
            return {
                kind: Kind.OPERATION_DEFINITION,
                operation: 'query',
                name: undefined,
                variableDefinitions: [],
                directives: [],
                selectionSet: this.parseSelectionSet(),
                loc: this.loc(start)
            };
        }
        const operation = this.parseOperationType();
        let name;
        if (this.peek(TokenKind.NAME)) {
            name = this.parseName();
        }
        return {
            kind: Kind.OPERATION_DEFINITION,
            operation,
            name,
            variableDefinitions: this.parseVariableDefinitions(),
            directives: this.parseDirectives(false),
            selectionSet: this.parseSelectionSet(),
            loc: this.loc(start)
        };
    }
    parseOperationType() {
        const operationToken = this.expectToken(TokenKind.NAME);
        switch(operationToken.value){
            case 'query':
                return 'query';
            case 'mutation':
                return 'mutation';
            case 'subscription':
                return 'subscription';
        }
        throw this.unexpected(operationToken);
    }
    parseVariableDefinitions() {
        return this.optionalMany(TokenKind.PAREN_L, this.parseVariableDefinition, TokenKind.PAREN_R);
    }
    parseVariableDefinition() {
        const start = this._lexer.token;
        return {
            kind: Kind.VARIABLE_DEFINITION,
            variable: this.parseVariable(),
            type: (this.expectToken(TokenKind.COLON), this.parseTypeReference()),
            defaultValue: this.expectOptionalToken(TokenKind.EQUALS) ? this.parseValueLiteral(true) : undefined,
            directives: this.parseDirectives(true),
            loc: this.loc(start)
        };
    }
    parseVariable() {
        const start = this._lexer.token;
        this.expectToken(TokenKind.DOLLAR);
        return {
            kind: Kind.VARIABLE,
            name: this.parseName(),
            loc: this.loc(start)
        };
    }
    parseSelectionSet() {
        const start = this._lexer.token;
        return {
            kind: Kind.SELECTION_SET,
            selections: this.many(TokenKind.BRACE_L, this.parseSelection, TokenKind.BRACE_R),
            loc: this.loc(start)
        };
    }
    parseSelection() {
        return this.peek(TokenKind.SPREAD) ? this.parseFragment() : this.parseField();
    }
    parseField() {
        const start = this._lexer.token;
        const nameOrAlias = this.parseName();
        let alias;
        let name;
        if (this.expectOptionalToken(TokenKind.COLON)) {
            alias = nameOrAlias;
            name = this.parseName();
        } else {
            name = nameOrAlias;
        }
        return {
            kind: Kind.FIELD,
            alias,
            name,
            arguments: this.parseArguments(false),
            directives: this.parseDirectives(false),
            selectionSet: this.peek(TokenKind.BRACE_L) ? this.parseSelectionSet() : undefined,
            loc: this.loc(start)
        };
    }
    parseArguments(isConst) {
        const item = isConst ? this.parseConstArgument : this.parseArgument;
        return this.optionalMany(TokenKind.PAREN_L, item, TokenKind.PAREN_R);
    }
    parseArgument() {
        const start = this._lexer.token;
        const name = this.parseName();
        this.expectToken(TokenKind.COLON);
        return {
            kind: Kind.ARGUMENT,
            name,
            value: this.parseValueLiteral(false),
            loc: this.loc(start)
        };
    }
    parseConstArgument() {
        const start = this._lexer.token;
        return {
            kind: Kind.ARGUMENT,
            name: this.parseName(),
            value: (this.expectToken(TokenKind.COLON), this.parseValueLiteral(true)),
            loc: this.loc(start)
        };
    }
    parseFragment() {
        const start = this._lexer.token;
        this.expectToken(TokenKind.SPREAD);
        const hasTypeCondition = this.expectOptionalKeyword('on');
        if (!hasTypeCondition && this.peek(TokenKind.NAME)) {
            return {
                kind: Kind.FRAGMENT_SPREAD,
                name: this.parseFragmentName(),
                directives: this.parseDirectives(false),
                loc: this.loc(start)
            };
        }
        return {
            kind: Kind.INLINE_FRAGMENT,
            typeCondition: hasTypeCondition ? this.parseNamedType() : undefined,
            directives: this.parseDirectives(false),
            selectionSet: this.parseSelectionSet(),
            loc: this.loc(start)
        };
    }
    parseFragmentDefinition() {
        const start = this._lexer.token;
        this.expectKeyword('fragment');
        if (this._options?.experimentalFragmentVariables === true) {
            return {
                kind: Kind.FRAGMENT_DEFINITION,
                name: this.parseFragmentName(),
                variableDefinitions: this.parseVariableDefinitions(),
                typeCondition: (this.expectKeyword('on'), this.parseNamedType()),
                directives: this.parseDirectives(false),
                selectionSet: this.parseSelectionSet(),
                loc: this.loc(start)
            };
        }
        return {
            kind: Kind.FRAGMENT_DEFINITION,
            name: this.parseFragmentName(),
            typeCondition: (this.expectKeyword('on'), this.parseNamedType()),
            directives: this.parseDirectives(false),
            selectionSet: this.parseSelectionSet(),
            loc: this.loc(start)
        };
    }
    parseFragmentName() {
        if (this._lexer.token.value === 'on') {
            throw this.unexpected();
        }
        return this.parseName();
    }
    parseValueLiteral(isConst) {
        const token = this._lexer.token;
        switch(token.kind){
            case TokenKind.BRACKET_L:
                return this.parseList(isConst);
            case TokenKind.BRACE_L:
                return this.parseObject(isConst);
            case TokenKind.INT:
                this._lexer.advance();
                return {
                    kind: Kind.INT,
                    value: token.value,
                    loc: this.loc(token)
                };
            case TokenKind.FLOAT:
                this._lexer.advance();
                return {
                    kind: Kind.FLOAT,
                    value: token.value,
                    loc: this.loc(token)
                };
            case TokenKind.STRING:
            case TokenKind.BLOCK_STRING:
                return this.parseStringLiteral();
            case TokenKind.NAME:
                this._lexer.advance();
                switch(token.value){
                    case 'true':
                        return {
                            kind: Kind.BOOLEAN,
                            value: true,
                            loc: this.loc(token)
                        };
                    case 'false':
                        return {
                            kind: Kind.BOOLEAN,
                            value: false,
                            loc: this.loc(token)
                        };
                    case 'null':
                        return {
                            kind: Kind.NULL,
                            loc: this.loc(token)
                        };
                    default:
                        return {
                            kind: Kind.ENUM,
                            value: token.value,
                            loc: this.loc(token)
                        };
                }
            case TokenKind.DOLLAR:
                if (!isConst) {
                    return this.parseVariable();
                }
                break;
        }
        throw this.unexpected();
    }
    parseStringLiteral() {
        const token = this._lexer.token;
        this._lexer.advance();
        return {
            kind: Kind.STRING,
            value: token.value,
            block: token.kind === TokenKind.BLOCK_STRING,
            loc: this.loc(token)
        };
    }
    parseList(isConst) {
        const start = this._lexer.token;
        const item = ()=>this.parseValueLiteral(isConst)
        ;
        return {
            kind: Kind.LIST,
            values: this.any(TokenKind.BRACKET_L, item, TokenKind.BRACKET_R),
            loc: this.loc(start)
        };
    }
    parseObject(isConst) {
        const start = this._lexer.token;
        const item = ()=>this.parseObjectField(isConst)
        ;
        return {
            kind: Kind.OBJECT,
            fields: this.any(TokenKind.BRACE_L, item, TokenKind.BRACE_R),
            loc: this.loc(start)
        };
    }
    parseObjectField(isConst) {
        const start = this._lexer.token;
        const name = this.parseName();
        this.expectToken(TokenKind.COLON);
        return {
            kind: Kind.OBJECT_FIELD,
            name,
            value: this.parseValueLiteral(isConst),
            loc: this.loc(start)
        };
    }
    parseDirectives(isConst) {
        const directives = [];
        while(this.peek(TokenKind.AT)){
            directives.push(this.parseDirective(isConst));
        }
        return directives;
    }
    parseDirective(isConst) {
        const start = this._lexer.token;
        this.expectToken(TokenKind.AT);
        return {
            kind: Kind.DIRECTIVE,
            name: this.parseName(),
            arguments: this.parseArguments(isConst),
            loc: this.loc(start)
        };
    }
    parseTypeReference() {
        const start = this._lexer.token;
        let type1;
        if (this.expectOptionalToken(TokenKind.BRACKET_L)) {
            type1 = this.parseTypeReference();
            this.expectToken(TokenKind.BRACKET_R);
            type1 = {
                kind: Kind.LIST_TYPE,
                type: type1,
                loc: this.loc(start)
            };
        } else {
            type1 = this.parseNamedType();
        }
        if (this.expectOptionalToken(TokenKind.BANG)) {
            return {
                kind: Kind.NON_NULL_TYPE,
                type: type1,
                loc: this.loc(start)
            };
        }
        return type1;
    }
    parseNamedType() {
        const start = this._lexer.token;
        return {
            kind: Kind.NAMED_TYPE,
            name: this.parseName(),
            loc: this.loc(start)
        };
    }
    parseTypeSystemDefinition() {
        const keywordToken = this.peekDescription() ? this._lexer.lookahead() : this._lexer.token;
        if (keywordToken.kind === TokenKind.NAME) {
            switch(keywordToken.value){
                case 'schema':
                    return this.parseSchemaDefinition();
                case 'scalar':
                    return this.parseScalarTypeDefinition();
                case 'type':
                    return this.parseObjectTypeDefinition();
                case 'interface':
                    return this.parseInterfaceTypeDefinition();
                case 'union':
                    return this.parseUnionTypeDefinition();
                case 'enum':
                    return this.parseEnumTypeDefinition();
                case 'input':
                    return this.parseInputObjectTypeDefinition();
                case 'directive':
                    return this.parseDirectiveDefinition();
            }
        }
        throw this.unexpected(keywordToken);
    }
    peekDescription() {
        return this.peek(TokenKind.STRING) || this.peek(TokenKind.BLOCK_STRING);
    }
    parseDescription() {
        if (this.peekDescription()) {
            return this.parseStringLiteral();
        }
    }
    parseSchemaDefinition() {
        const start = this._lexer.token;
        const description = this.parseDescription();
        this.expectKeyword('schema');
        const directives = this.parseDirectives(true);
        const operationTypes = this.many(TokenKind.BRACE_L, this.parseOperationTypeDefinition, TokenKind.BRACE_R);
        return {
            kind: Kind.SCHEMA_DEFINITION,
            description,
            directives,
            operationTypes,
            loc: this.loc(start)
        };
    }
    parseOperationTypeDefinition() {
        const start = this._lexer.token;
        const operation = this.parseOperationType();
        this.expectToken(TokenKind.COLON);
        const type2 = this.parseNamedType();
        return {
            kind: Kind.OPERATION_TYPE_DEFINITION,
            operation,
            type: type2,
            loc: this.loc(start)
        };
    }
    parseScalarTypeDefinition() {
        const start = this._lexer.token;
        const description = this.parseDescription();
        this.expectKeyword('scalar');
        const name = this.parseName();
        const directives = this.parseDirectives(true);
        return {
            kind: Kind.SCALAR_TYPE_DEFINITION,
            description,
            name,
            directives,
            loc: this.loc(start)
        };
    }
    parseObjectTypeDefinition() {
        const start = this._lexer.token;
        const description = this.parseDescription();
        this.expectKeyword('type');
        const name = this.parseName();
        const interfaces = this.parseImplementsInterfaces();
        const directives = this.parseDirectives(true);
        const fields = this.parseFieldsDefinition();
        return {
            kind: Kind.OBJECT_TYPE_DEFINITION,
            description,
            name,
            interfaces,
            directives,
            fields,
            loc: this.loc(start)
        };
    }
    parseImplementsInterfaces() {
        const types = [];
        if (this.expectOptionalKeyword('implements')) {
            this.expectOptionalToken(TokenKind.AMP);
            do {
                types.push(this.parseNamedType());
            }while (this.expectOptionalToken(TokenKind.AMP) || this._options?.allowLegacySDLImplementsInterfaces === true && this.peek(TokenKind.NAME))
        }
        return types;
    }
    parseFieldsDefinition() {
        if (this._options?.allowLegacySDLEmptyFields === true && this.peek(TokenKind.BRACE_L) && this._lexer.lookahead().kind === TokenKind.BRACE_R) {
            this._lexer.advance();
            this._lexer.advance();
            return [];
        }
        return this.optionalMany(TokenKind.BRACE_L, this.parseFieldDefinition, TokenKind.BRACE_R);
    }
    parseFieldDefinition() {
        const start = this._lexer.token;
        const description = this.parseDescription();
        const name = this.parseName();
        const args = this.parseArgumentDefs();
        this.expectToken(TokenKind.COLON);
        const type3 = this.parseTypeReference();
        const directives = this.parseDirectives(true);
        return {
            kind: Kind.FIELD_DEFINITION,
            description,
            name,
            arguments: args,
            type: type3,
            directives,
            loc: this.loc(start)
        };
    }
    parseArgumentDefs() {
        return this.optionalMany(TokenKind.PAREN_L, this.parseInputValueDef, TokenKind.PAREN_R);
    }
    parseInputValueDef() {
        const start = this._lexer.token;
        const description = this.parseDescription();
        const name = this.parseName();
        this.expectToken(TokenKind.COLON);
        const type4 = this.parseTypeReference();
        let defaultValue;
        if (this.expectOptionalToken(TokenKind.EQUALS)) {
            defaultValue = this.parseValueLiteral(true);
        }
        const directives = this.parseDirectives(true);
        return {
            kind: Kind.INPUT_VALUE_DEFINITION,
            description,
            name,
            type: type4,
            defaultValue,
            directives,
            loc: this.loc(start)
        };
    }
    parseInterfaceTypeDefinition() {
        const start = this._lexer.token;
        const description = this.parseDescription();
        this.expectKeyword('interface');
        const name = this.parseName();
        const interfaces = this.parseImplementsInterfaces();
        const directives = this.parseDirectives(true);
        const fields = this.parseFieldsDefinition();
        return {
            kind: Kind.INTERFACE_TYPE_DEFINITION,
            description,
            name,
            interfaces,
            directives,
            fields,
            loc: this.loc(start)
        };
    }
    parseUnionTypeDefinition() {
        const start = this._lexer.token;
        const description = this.parseDescription();
        this.expectKeyword('union');
        const name = this.parseName();
        const directives = this.parseDirectives(true);
        const types = this.parseUnionMemberTypes();
        return {
            kind: Kind.UNION_TYPE_DEFINITION,
            description,
            name,
            directives,
            types,
            loc: this.loc(start)
        };
    }
    parseUnionMemberTypes() {
        const types = [];
        if (this.expectOptionalToken(TokenKind.EQUALS)) {
            this.expectOptionalToken(TokenKind.PIPE);
            do {
                types.push(this.parseNamedType());
            }while (this.expectOptionalToken(TokenKind.PIPE))
        }
        return types;
    }
    parseEnumTypeDefinition() {
        const start = this._lexer.token;
        const description = this.parseDescription();
        this.expectKeyword('enum');
        const name = this.parseName();
        const directives = this.parseDirectives(true);
        const values1 = this.parseEnumValuesDefinition();
        return {
            kind: Kind.ENUM_TYPE_DEFINITION,
            description,
            name,
            directives,
            values: values1,
            loc: this.loc(start)
        };
    }
    parseEnumValuesDefinition() {
        return this.optionalMany(TokenKind.BRACE_L, this.parseEnumValueDefinition, TokenKind.BRACE_R);
    }
    parseEnumValueDefinition() {
        const start = this._lexer.token;
        const description = this.parseDescription();
        const name = this.parseName();
        const directives = this.parseDirectives(true);
        return {
            kind: Kind.ENUM_VALUE_DEFINITION,
            description,
            name,
            directives,
            loc: this.loc(start)
        };
    }
    parseInputObjectTypeDefinition() {
        const start = this._lexer.token;
        const description = this.parseDescription();
        this.expectKeyword('input');
        const name = this.parseName();
        const directives = this.parseDirectives(true);
        const fields = this.parseInputFieldsDefinition();
        return {
            kind: Kind.INPUT_OBJECT_TYPE_DEFINITION,
            description,
            name,
            directives,
            fields,
            loc: this.loc(start)
        };
    }
    parseInputFieldsDefinition() {
        return this.optionalMany(TokenKind.BRACE_L, this.parseInputValueDef, TokenKind.BRACE_R);
    }
    parseTypeSystemExtension() {
        const keywordToken = this._lexer.lookahead();
        if (keywordToken.kind === TokenKind.NAME) {
            switch(keywordToken.value){
                case 'schema':
                    return this.parseSchemaExtension();
                case 'scalar':
                    return this.parseScalarTypeExtension();
                case 'type':
                    return this.parseObjectTypeExtension();
                case 'interface':
                    return this.parseInterfaceTypeExtension();
                case 'union':
                    return this.parseUnionTypeExtension();
                case 'enum':
                    return this.parseEnumTypeExtension();
                case 'input':
                    return this.parseInputObjectTypeExtension();
            }
        }
        throw this.unexpected(keywordToken);
    }
    parseSchemaExtension() {
        const start = this._lexer.token;
        this.expectKeyword('extend');
        this.expectKeyword('schema');
        const directives = this.parseDirectives(true);
        const operationTypes = this.optionalMany(TokenKind.BRACE_L, this.parseOperationTypeDefinition, TokenKind.BRACE_R);
        if (directives.length === 0 && operationTypes.length === 0) {
            throw this.unexpected();
        }
        return {
            kind: Kind.SCHEMA_EXTENSION,
            directives,
            operationTypes,
            loc: this.loc(start)
        };
    }
    parseScalarTypeExtension() {
        const start = this._lexer.token;
        this.expectKeyword('extend');
        this.expectKeyword('scalar');
        const name = this.parseName();
        const directives = this.parseDirectives(true);
        if (directives.length === 0) {
            throw this.unexpected();
        }
        return {
            kind: Kind.SCALAR_TYPE_EXTENSION,
            name,
            directives,
            loc: this.loc(start)
        };
    }
    parseObjectTypeExtension() {
        const start = this._lexer.token;
        this.expectKeyword('extend');
        this.expectKeyword('type');
        const name = this.parseName();
        const interfaces = this.parseImplementsInterfaces();
        const directives = this.parseDirectives(true);
        const fields = this.parseFieldsDefinition();
        if (interfaces.length === 0 && directives.length === 0 && fields.length === 0) {
            throw this.unexpected();
        }
        return {
            kind: Kind.OBJECT_TYPE_EXTENSION,
            name,
            interfaces,
            directives,
            fields,
            loc: this.loc(start)
        };
    }
    parseInterfaceTypeExtension() {
        const start = this._lexer.token;
        this.expectKeyword('extend');
        this.expectKeyword('interface');
        const name = this.parseName();
        const interfaces = this.parseImplementsInterfaces();
        const directives = this.parseDirectives(true);
        const fields = this.parseFieldsDefinition();
        if (interfaces.length === 0 && directives.length === 0 && fields.length === 0) {
            throw this.unexpected();
        }
        return {
            kind: Kind.INTERFACE_TYPE_EXTENSION,
            name,
            interfaces,
            directives,
            fields,
            loc: this.loc(start)
        };
    }
    parseUnionTypeExtension() {
        const start = this._lexer.token;
        this.expectKeyword('extend');
        this.expectKeyword('union');
        const name = this.parseName();
        const directives = this.parseDirectives(true);
        const types = this.parseUnionMemberTypes();
        if (directives.length === 0 && types.length === 0) {
            throw this.unexpected();
        }
        return {
            kind: Kind.UNION_TYPE_EXTENSION,
            name,
            directives,
            types,
            loc: this.loc(start)
        };
    }
    parseEnumTypeExtension() {
        const start = this._lexer.token;
        this.expectKeyword('extend');
        this.expectKeyword('enum');
        const name = this.parseName();
        const directives = this.parseDirectives(true);
        const values2 = this.parseEnumValuesDefinition();
        if (directives.length === 0 && values2.length === 0) {
            throw this.unexpected();
        }
        return {
            kind: Kind.ENUM_TYPE_EXTENSION,
            name,
            directives,
            values: values2,
            loc: this.loc(start)
        };
    }
    parseInputObjectTypeExtension() {
        const start = this._lexer.token;
        this.expectKeyword('extend');
        this.expectKeyword('input');
        const name = this.parseName();
        const directives = this.parseDirectives(true);
        const fields = this.parseInputFieldsDefinition();
        if (directives.length === 0 && fields.length === 0) {
            throw this.unexpected();
        }
        return {
            kind: Kind.INPUT_OBJECT_TYPE_EXTENSION,
            name,
            directives,
            fields,
            loc: this.loc(start)
        };
    }
    parseDirectiveDefinition() {
        const start = this._lexer.token;
        const description = this.parseDescription();
        this.expectKeyword('directive');
        this.expectToken(TokenKind.AT);
        const name = this.parseName();
        const args = this.parseArgumentDefs();
        const repeatable = this.expectOptionalKeyword('repeatable');
        this.expectKeyword('on');
        const locations = this.parseDirectiveLocations();
        return {
            kind: Kind.DIRECTIVE_DEFINITION,
            description,
            name,
            arguments: args,
            repeatable,
            locations,
            loc: this.loc(start)
        };
    }
    parseDirectiveLocations() {
        this.expectOptionalToken(TokenKind.PIPE);
        const locations = [];
        do {
            locations.push(this.parseDirectiveLocation());
        }while (this.expectOptionalToken(TokenKind.PIPE))
        return locations;
    }
    parseDirectiveLocation() {
        const start = this._lexer.token;
        const name = this.parseName();
        if (DirectiveLocation[name.value] !== undefined) {
            return name;
        }
        throw this.unexpected(start);
    }
    loc(startToken) {
        if (this._options?.noLocation !== true) {
            return new Location(startToken, this._lexer.lastToken, this._lexer.source);
        }
    }
    peek(kind) {
        return this._lexer.token.kind === kind;
    }
    expectToken(kind) {
        const token = this._lexer.token;
        if (token.kind === kind) {
            this._lexer.advance();
            return token;
        }
        throw syntaxError(this._lexer.source, token.start, `Expected ${getTokenKindDesc(kind)}, found ${getTokenDesc(token)}.`);
    }
    expectOptionalToken(kind) {
        const token = this._lexer.token;
        if (token.kind === kind) {
            this._lexer.advance();
            return token;
        }
        return undefined;
    }
    expectKeyword(value) {
        const token = this._lexer.token;
        if (token.kind === TokenKind.NAME && token.value === value) {
            this._lexer.advance();
        } else {
            throw syntaxError(this._lexer.source, token.start, `Expected "${value}", found ${getTokenDesc(token)}.`);
        }
    }
    expectOptionalKeyword(value) {
        const token = this._lexer.token;
        if (token.kind === TokenKind.NAME && token.value === value) {
            this._lexer.advance();
            return true;
        }
        return false;
    }
    unexpected(atToken) {
        const token = atToken ?? this._lexer.token;
        return syntaxError(this._lexer.source, token.start, `Unexpected ${getTokenDesc(token)}.`);
    }
    any(openKind, parseFn, closeKind) {
        this.expectToken(openKind);
        const nodes = [];
        while(!this.expectOptionalToken(closeKind)){
            nodes.push(parseFn.call(this));
        }
        return nodes;
    }
    optionalMany(openKind, parseFn, closeKind) {
        if (this.expectOptionalToken(openKind)) {
            const nodes = [];
            do {
                nodes.push(parseFn.call(this));
            }while (!this.expectOptionalToken(closeKind))
            return nodes;
        }
        return [];
    }
    many(openKind, parseFn, closeKind) {
        this.expectToken(openKind);
        const nodes = [];
        do {
            nodes.push(parseFn.call(this));
        }while (!this.expectOptionalToken(closeKind))
        return nodes;
    }
}
function getTokenDesc(token) {
    const value = token.value;
    return getTokenKindDesc(token.kind) + (value != null ? ` "${value}"` : '');
}
function getTokenKindDesc(kind) {
    return isPunctuatorTokenKind(kind) ? `"${kind}"` : kind;
}
const QueryDocumentKeys = {
    Name: [],
    Document: [
        'definitions'
    ],
    OperationDefinition: [
        'name',
        'variableDefinitions',
        'directives',
        'selectionSet'
    ],
    VariableDefinition: [
        'variable',
        'type',
        'defaultValue',
        'directives'
    ],
    Variable: [
        'name'
    ],
    SelectionSet: [
        'selections'
    ],
    Field: [
        'alias',
        'name',
        'arguments',
        'directives',
        'selectionSet'
    ],
    Argument: [
        'name',
        'value'
    ],
    FragmentSpread: [
        'name',
        'directives'
    ],
    InlineFragment: [
        'typeCondition',
        'directives',
        'selectionSet'
    ],
    FragmentDefinition: [
        'name',
        'variableDefinitions',
        'typeCondition',
        'directives',
        'selectionSet'
    ],
    IntValue: [],
    FloatValue: [],
    StringValue: [],
    BooleanValue: [],
    NullValue: [],
    EnumValue: [],
    ListValue: [
        'values'
    ],
    ObjectValue: [
        'fields'
    ],
    ObjectField: [
        'name',
        'value'
    ],
    Directive: [
        'name',
        'arguments'
    ],
    NamedType: [
        'name'
    ],
    ListType: [
        'type'
    ],
    NonNullType: [
        'type'
    ],
    SchemaDefinition: [
        'description',
        'directives',
        'operationTypes'
    ],
    OperationTypeDefinition: [
        'type'
    ],
    ScalarTypeDefinition: [
        'description',
        'name',
        'directives'
    ],
    ObjectTypeDefinition: [
        'description',
        'name',
        'interfaces',
        'directives',
        'fields'
    ],
    FieldDefinition: [
        'description',
        'name',
        'arguments',
        'type',
        'directives'
    ],
    InputValueDefinition: [
        'description',
        'name',
        'type',
        'defaultValue',
        'directives'
    ],
    InterfaceTypeDefinition: [
        'description',
        'name',
        'interfaces',
        'directives',
        'fields'
    ],
    UnionTypeDefinition: [
        'description',
        'name',
        'directives',
        'types'
    ],
    EnumTypeDefinition: [
        'description',
        'name',
        'directives',
        'values'
    ],
    EnumValueDefinition: [
        'description',
        'name',
        'directives'
    ],
    InputObjectTypeDefinition: [
        'description',
        'name',
        'directives',
        'fields'
    ],
    DirectiveDefinition: [
        'description',
        'name',
        'arguments',
        'locations'
    ],
    SchemaExtension: [
        'directives',
        'operationTypes'
    ],
    ScalarTypeExtension: [
        'name',
        'directives'
    ],
    ObjectTypeExtension: [
        'name',
        'interfaces',
        'directives',
        'fields'
    ],
    InterfaceTypeExtension: [
        'name',
        'interfaces',
        'directives',
        'fields'
    ],
    UnionTypeExtension: [
        'name',
        'directives',
        'types'
    ],
    EnumTypeExtension: [
        'name',
        'directives',
        'values'
    ],
    InputObjectTypeExtension: [
        'name',
        'directives',
        'fields'
    ]
};
const BREAK = Object.freeze({});
function visit(root, visitor, visitorKeys = QueryDocumentKeys) {
    let stack = undefined;
    let inArray = Array.isArray(root);
    let keys2 = [
        root
    ];
    let index1 = -1;
    let edits = [];
    let node = undefined;
    let key = undefined;
    let parent = undefined;
    const path2 = [];
    const ancestors = [];
    let newRoot = root;
    do {
        index1++;
        const isLeaving = index1 === keys2.length;
        const isEdited = isLeaving && edits.length !== 0;
        if (isLeaving) {
            key = ancestors.length === 0 ? undefined : path2[path2.length - 1];
            node = parent;
            parent = ancestors.pop();
            if (isEdited) {
                if (inArray) {
                    node = node.slice();
                } else {
                    const clone1 = {};
                    for (const k of Object.keys(node)){
                        clone1[k] = node[k];
                    }
                    node = clone1;
                }
                let editOffset = 0;
                for(let ii = 0; ii < edits.length; ii++){
                    let editKey = edits[ii][0];
                    const editValue = edits[ii][1];
                    if (inArray) {
                        editKey -= editOffset;
                    }
                    if (inArray && editValue === null) {
                        node.splice(editKey, 1);
                        editOffset++;
                    } else {
                        node[editKey] = editValue;
                    }
                }
            }
            index1 = stack.index;
            keys2 = stack.keys;
            edits = stack.edits;
            inArray = stack.inArray;
            stack = stack.prev;
        } else {
            key = parent ? inArray ? index1 : keys2[index1] : undefined;
            node = parent ? parent[key] : newRoot;
            if (node === null || node === undefined) {
                continue;
            }
            if (parent) {
                path2.push(key);
            }
        }
        let result;
        if (!Array.isArray(node)) {
            if (!isNode(node)) {
                throw new Error(`Invalid AST Node: ${inspect(node)}.`);
            }
            const visitFn = getVisitFn(visitor, node.kind, isLeaving);
            if (visitFn) {
                result = visitFn.call(visitor, node, key, parent, path2, ancestors);
                if (result === BREAK) {
                    break;
                }
                if (result === false) {
                    if (!isLeaving) {
                        path2.pop();
                        continue;
                    }
                } else if (result !== undefined) {
                    edits.push([
                        key,
                        result
                    ]);
                    if (!isLeaving) {
                        if (isNode(result)) {
                            node = result;
                        } else {
                            path2.pop();
                            continue;
                        }
                    }
                }
            }
        }
        if (result === undefined && isEdited) {
            edits.push([
                key,
                node
            ]);
        }
        if (isLeaving) {
            path2.pop();
        } else {
            stack = {
                inArray,
                index: index1,
                keys: keys2,
                edits,
                prev: stack
            };
            inArray = Array.isArray(node);
            keys2 = inArray ? node : visitorKeys[node.kind] ?? [];
            index1 = -1;
            edits = [];
            if (parent) {
                ancestors.push(parent);
            }
            parent = node;
        }
    }while (stack !== undefined)
    if (edits.length !== 0) {
        newRoot = edits[edits.length - 1][1];
    }
    return newRoot;
}
function visitInParallel(visitors) {
    const skipping = new Array(visitors.length);
    return {
        enter (node) {
            for(let i8 = 0; i8 < visitors.length; i8++){
                if (skipping[i8] == null) {
                    const fn = getVisitFn(visitors[i8], node.kind, false);
                    if (fn) {
                        const result = fn.apply(visitors[i8], arguments);
                        if (result === false) {
                            skipping[i8] = node;
                        } else if (result === BREAK) {
                            skipping[i8] = BREAK;
                        } else if (result !== undefined) {
                            return result;
                        }
                    }
                }
            }
        },
        leave (node) {
            for(let i9 = 0; i9 < visitors.length; i9++){
                if (skipping[i9] == null) {
                    const fn = getVisitFn(visitors[i9], node.kind, true);
                    if (fn) {
                        const result = fn.apply(visitors[i9], arguments);
                        if (result === BREAK) {
                            skipping[i9] = BREAK;
                        } else if (result !== undefined && result !== false) {
                            return result;
                        }
                    }
                } else if (skipping[i9] === node) {
                    skipping[i9] = null;
                }
            }
        }
    };
}
function getVisitFn(visitor, kind, isLeaving) {
    const kindVisitor = visitor[kind];
    if (kindVisitor) {
        if (!isLeaving && typeof kindVisitor === 'function') {
            return kindVisitor;
        }
        const kindSpecificVisitor = isLeaving ? kindVisitor.leave : kindVisitor.enter;
        if (typeof kindSpecificVisitor === 'function') {
            return kindSpecificVisitor;
        }
    } else {
        const specificVisitor = isLeaving ? visitor.leave : visitor.enter;
        if (specificVisitor) {
            if (typeof specificVisitor === 'function') {
                return specificVisitor;
            }
            const specificKindVisitor = specificVisitor[kind];
            if (typeof specificKindVisitor === 'function') {
                return specificKindVisitor;
            }
        }
    }
}
const find = Array.prototype.find ? function(list3, predicate) {
    return Array.prototype.find.call(list3, predicate);
} : function(list4, predicate) {
    for (const value of list4){
        if (predicate(value)) {
            return value;
        }
    }
};
const flatMapMethod = Array.prototype.flatMap;
const flatMap = flatMapMethod ? function(list5, fn) {
    return flatMapMethod.call(list5, fn);
} : function(list6, fn) {
    let result = [];
    for (const item of list6){
        const value = fn(item);
        if (Array.isArray(value)) {
            result = result.concat(value);
        } else {
            result.push(value);
        }
    }
    return result;
};
const objectValues = Object.values || ((obj)=>Object.keys(obj).map((key)=>obj[key]
    )
);
function locatedError(originalError, nodes, path3) {
    if (Array.isArray(originalError.path)) {
        return originalError;
    }
    return new GraphQLError(originalError.message, originalError.nodes ?? nodes, originalError.source, originalError.positions, path3, originalError);
}
const NAME_RX = /^[_a-zA-Z][_a-zA-Z0-9]*$/;
function isValidNameError(name) {
    devAssert(typeof name === 'string', 'Expected name to be a string.');
    if (name.length > 1 && name[0] === '_' && name[1] === '_') {
        return new GraphQLError(`Name "${name}" must not begin with "__", which is reserved by GraphQL introspection.`);
    }
    if (!NAME_RX.test(name)) {
        return new GraphQLError(`Names must match /^[_a-zA-Z][_a-zA-Z0-9]*$/ but "${name}" does not.`);
    }
}
const objectEntries = Object.entries || ((obj)=>Object.keys(obj).map((key)=>[
            key,
            obj[key]
        ]
    )
);
function keyMap(list7, keyFn) {
    return list7.reduce((map1, item)=>{
        map1[keyFn(item)] = item;
        return map1;
    }, Object.create(null));
}
function mapValue(map2, fn) {
    const result = Object.create(null);
    for (const [key, value] of objectEntries(map2)){
        result[key] = fn(value, key);
    }
    return result;
}
function toObjMap(obj) {
    if (Object.getPrototypeOf(obj) === null) {
        return obj;
    }
    const map3 = Object.create(null);
    for (const [key, value] of objectEntries(obj)){
        map3[key] = value;
    }
    return map3;
}
function keyValMap(list8, keyFn, valFn) {
    return list8.reduce((map4, item)=>{
        map4[keyFn(item)] = valFn(item);
        return map4;
    }, Object.create(null));
}
const __default = Deno.env.NODE_ENV === 'production' ? function instanceOf(value, constructor) {
    return value instanceof constructor;
} : function instanceOf(value, constructor) {
    if (value instanceof constructor) {
        return true;
    }
    if (value) {
        const valueClass = value.constructor;
        const className = constructor.name;
        if (className && valueClass && valueClass.name === className) {
            throw new Error(`Cannot use ${className} "${value}" from another module or realm.

Ensure that there is only one instance of "graphql" in the node_modules
directory. If different versions of "graphql" are the dependencies of other
relied on modules, use "resolutions" to ensure only one version is installed.

https://yarnpkg.com/en/docs/selective-version-resolutions

Duplicate "graphql" modules cannot be used at the same time since different
versions may have different capabilities and behavior. The data from one
version used in the function from another could produce confusing and
spurious results.`);
        }
    }
    return false;
};
function didYouMean(firstArg, secondArg) {
    const [subMessage, suggestionsArg] = typeof firstArg === 'string' ? [
        firstArg,
        secondArg
    ] : [
        undefined,
        firstArg
    ];
    let message = ' Did you mean ';
    if (subMessage) {
        message += subMessage + ' ';
    }
    const suggestions = suggestionsArg.map((x)=>`"${x}"`
    );
    switch(suggestions.length){
        case 0:
            return '';
        case 1:
            return message + suggestions[0] + '?';
        case 2:
            return message + suggestions[0] + ' or ' + suggestions[1] + '?';
    }
    const selected = suggestions.slice(0, 5);
    const lastItem = selected.pop();
    return message + selected.join(', ') + ', or ' + lastItem + '?';
}
function identityFunc(x) {
    return x;
}
function suggestionList(input, options) {
    const optionsByDistance = Object.create(null);
    const lexicalDistance = new LexicalDistance(input);
    const threshold = Math.floor(input.length * 0.4) + 1;
    for (const option of options){
        const distance = lexicalDistance.measure(option, threshold);
        if (distance !== undefined) {
            optionsByDistance[option] = distance;
        }
    }
    return Object.keys(optionsByDistance).sort((a, b)=>{
        const distanceDiff = optionsByDistance[a] - optionsByDistance[b];
        return distanceDiff !== 0 ? distanceDiff : a.localeCompare(b);
    });
}
class LexicalDistance {
    constructor(input){
        this._input = input;
        this._inputLowerCase = input.toLowerCase();
        this._inputArray = stringToArray(this._inputLowerCase);
        this._rows = [
            new Array(input.length + 1).fill(0),
            new Array(input.length + 1).fill(0),
            new Array(input.length + 1).fill(0)
        ];
    }
    measure(option, threshold) {
        if (this._input === option) {
            return 0;
        }
        const optionLowerCase = option.toLowerCase();
        if (this._inputLowerCase === optionLowerCase) {
            return 1;
        }
        let a = stringToArray(optionLowerCase);
        let b = this._inputArray;
        if (a.length < b.length) {
            const tmp = a;
            a = b;
            b = tmp;
        }
        const aLength = a.length;
        const bLength = b.length;
        if (aLength - bLength > threshold) {
            return undefined;
        }
        const rows = this._rows;
        for(let j = 0; j <= bLength; j++){
            rows[0][j] = j;
        }
        for(let i10 = 1; i10 <= aLength; i10++){
            const upRow = rows[(i10 - 1) % 3];
            const currentRow = rows[i10 % 3];
            let smallestCell = currentRow[0] = i10;
            for(let j = 1; j <= bLength; j++){
                const cost = a[i10 - 1] === b[j - 1] ? 0 : 1;
                let currentCell = Math.min(upRow[j] + 1, currentRow[j - 1] + 1, upRow[j - 1] + cost);
                if (i10 > 1 && j > 1 && a[i10 - 1] === b[j - 2] && a[i10 - 2] === b[j - 1]) {
                    const doubleDiagonalCell = rows[(i10 - 2) % 3][j - 2];
                    currentCell = Math.min(currentCell, doubleDiagonalCell + 1);
                }
                if (currentCell < smallestCell) {
                    smallestCell = currentCell;
                }
                currentRow[j] = currentCell;
            }
            if (smallestCell > threshold) {
                return undefined;
            }
        }
        const distance = rows[aLength % 3][bLength];
        return distance <= threshold ? distance : undefined;
    }
}
function stringToArray(str) {
    const strLength = str.length;
    const array = new Array(strLength);
    for(let i11 = 0; i11 < strLength; ++i11){
        array[i11] = str.charCodeAt(i11);
    }
    return array;
}
function print(ast) {
    return visit(ast, {
        leave: printDocASTReducer
    });
}
const printDocASTReducer = {
    Name: (node)=>node.value
    ,
    Variable: (node)=>'$' + node.name
    ,
    Document: (node)=>join(node.definitions, '\n\n') + '\n'
    ,
    OperationDefinition (node) {
        const op = node.operation;
        const name = node.name;
        const varDefs = wrap('(', join(node.variableDefinitions, ', '), ')');
        const directives = join(node.directives, ' ');
        const selectionSet = node.selectionSet;
        return !name && !directives && !varDefs && op === 'query' ? selectionSet : join([
            op,
            join([
                name,
                varDefs
            ]),
            directives,
            selectionSet
        ], ' ');
    },
    VariableDefinition: ({ variable , type: type5 , defaultValue , directives  })=>variable + ': ' + type5 + wrap(' = ', defaultValue) + wrap(' ', join(directives, ' '))
    ,
    SelectionSet: ({ selections  })=>block(selections)
    ,
    Field: ({ alias , name , arguments: args , directives , selectionSet  })=>join([
            wrap('', alias, ': ') + name + wrap('(', join(args, ', '), ')'),
            join(directives, ' '),
            selectionSet
        ], ' ')
    ,
    Argument: ({ name , value  })=>name + ': ' + value
    ,
    FragmentSpread: ({ name , directives  })=>'...' + name + wrap(' ', join(directives, ' '))
    ,
    InlineFragment: ({ typeCondition , directives , selectionSet  })=>join([
            '...',
            wrap('on ', typeCondition),
            join(directives, ' '),
            selectionSet
        ], ' ')
    ,
    FragmentDefinition: ({ name , typeCondition , variableDefinitions , directives , selectionSet  })=>`fragment ${name}${wrap('(', join(variableDefinitions, ', '), ')')} ` + `on ${typeCondition} ${wrap('', join(directives, ' '), ' ')}` + selectionSet
    ,
    IntValue: ({ value  })=>value
    ,
    FloatValue: ({ value  })=>value
    ,
    StringValue: ({ value , block: isBlockString  }, key)=>isBlockString ? printBlockString(value, key === 'description' ? '' : '  ') : JSON.stringify(value)
    ,
    BooleanValue: ({ value  })=>value ? 'true' : 'false'
    ,
    NullValue: ()=>'null'
    ,
    EnumValue: ({ value  })=>value
    ,
    ListValue: ({ values: values3  })=>'[' + join(values3, ', ') + ']'
    ,
    ObjectValue: ({ fields  })=>'{' + join(fields, ', ') + '}'
    ,
    ObjectField: ({ name , value  })=>name + ': ' + value
    ,
    Directive: ({ name , arguments: args  })=>'@' + name + wrap('(', join(args, ', '), ')')
    ,
    NamedType: ({ name  })=>name
    ,
    ListType: ({ type: type6  })=>'[' + type6 + ']'
    ,
    NonNullType: ({ type: type7  })=>type7 + '!'
    ,
    SchemaDefinition: addDescription(({ directives , operationTypes  })=>join([
            'schema',
            join(directives, ' '),
            block(operationTypes)
        ], ' ')
    ),
    OperationTypeDefinition: ({ operation , type: type8  })=>operation + ': ' + type8
    ,
    ScalarTypeDefinition: addDescription(({ name , directives  })=>join([
            'scalar',
            name,
            join(directives, ' ')
        ], ' ')
    ),
    ObjectTypeDefinition: addDescription(({ name , interfaces , directives , fields  })=>join([
            'type',
            name,
            wrap('implements ', join(interfaces, ' & ')),
            join(directives, ' '),
            block(fields)
        ], ' ')
    ),
    FieldDefinition: addDescription(({ name , arguments: args , type: type9 , directives  })=>name + (hasMultilineItems(args) ? wrap('(\n', indent(join(args, '\n')), '\n)') : wrap('(', join(args, ', '), ')')) + ': ' + type9 + wrap(' ', join(directives, ' '))
    ),
    InputValueDefinition: addDescription(({ name , type: type10 , defaultValue , directives  })=>join([
            name + ': ' + type10,
            wrap('= ', defaultValue),
            join(directives, ' ')
        ], ' ')
    ),
    InterfaceTypeDefinition: addDescription(({ name , interfaces , directives , fields  })=>join([
            'interface',
            name,
            wrap('implements ', join(interfaces, ' & ')),
            join(directives, ' '),
            block(fields)
        ], ' ')
    ),
    UnionTypeDefinition: addDescription(({ name , directives , types  })=>join([
            'union',
            name,
            join(directives, ' '),
            types && types.length !== 0 ? '= ' + join(types, ' | ') : ''
        ], ' ')
    ),
    EnumTypeDefinition: addDescription(({ name , directives , values: values4  })=>join([
            'enum',
            name,
            join(directives, ' '),
            block(values4)
        ], ' ')
    ),
    EnumValueDefinition: addDescription(({ name , directives  })=>join([
            name,
            join(directives, ' ')
        ], ' ')
    ),
    InputObjectTypeDefinition: addDescription(({ name , directives , fields  })=>join([
            'input',
            name,
            join(directives, ' '),
            block(fields)
        ], ' ')
    ),
    DirectiveDefinition: addDescription(({ name , arguments: args , repeatable , locations  })=>'directive @' + name + (hasMultilineItems(args) ? wrap('(\n', indent(join(args, '\n')), '\n)') : wrap('(', join(args, ', '), ')')) + (repeatable ? ' repeatable' : '') + ' on ' + join(locations, ' | ')
    ),
    SchemaExtension: ({ directives , operationTypes  })=>join([
            'extend schema',
            join(directives, ' '),
            block(operationTypes)
        ], ' ')
    ,
    ScalarTypeExtension: ({ name , directives  })=>join([
            'extend scalar',
            name,
            join(directives, ' ')
        ], ' ')
    ,
    ObjectTypeExtension: ({ name , interfaces , directives , fields  })=>join([
            'extend type',
            name,
            wrap('implements ', join(interfaces, ' & ')),
            join(directives, ' '),
            block(fields)
        ], ' ')
    ,
    InterfaceTypeExtension: ({ name , interfaces , directives , fields  })=>join([
            'extend interface',
            name,
            wrap('implements ', join(interfaces, ' & ')),
            join(directives, ' '),
            block(fields)
        ], ' ')
    ,
    UnionTypeExtension: ({ name , directives , types  })=>join([
            'extend union',
            name,
            join(directives, ' '),
            types && types.length !== 0 ? '= ' + join(types, ' | ') : ''
        ], ' ')
    ,
    EnumTypeExtension: ({ name , directives , values: values5  })=>join([
            'extend enum',
            name,
            join(directives, ' '),
            block(values5)
        ], ' ')
    ,
    InputObjectTypeExtension: ({ name , directives , fields  })=>join([
            'extend input',
            name,
            join(directives, ' '),
            block(fields)
        ], ' ')
};
function addDescription(cb) {
    return (node)=>join([
            node.description,
            cb(node)
        ], '\n')
    ;
}
function join(maybeArray, separator = '') {
    return maybeArray?.filter((x)=>x
    ).join(separator) ?? '';
}
function block(array) {
    return array && array.length !== 0 ? '{\n' + indent(join(array, '\n')) + '\n}' : '';
}
function wrap(start, maybeString, end = '') {
    return maybeString ? start + maybeString + end : '';
}
function indent(maybeString) {
    return maybeString && '  ' + maybeString.replace(/\n/g, '\n  ');
}
function isMultiline(string) {
    return string.indexOf('\n') !== -1;
}
function hasMultilineItems(maybeArray) {
    return maybeArray && maybeArray.some(isMultiline);
}
function invariant(condition, message) {
    const booleanCondition = Boolean(condition);
    if (!booleanCondition) {
        throw new Error(message != null ? message : 'Unexpected invariant triggered.');
    }
}
function valueFromASTUntyped(valueNode, variables) {
    switch(valueNode.kind){
        case Kind.NULL:
            return null;
        case Kind.INT:
            return parseInt(valueNode.value, 10);
        case Kind.FLOAT:
            return parseFloat(valueNode.value);
        case Kind.STRING:
        case Kind.ENUM:
        case Kind.BOOLEAN:
            return valueNode.value;
        case Kind.LIST:
            return valueNode.values.map((node)=>valueFromASTUntyped(node, variables)
            );
        case Kind.OBJECT:
            return keyValMap(valueNode.fields, (field)=>field.name.value
            , (field)=>valueFromASTUntyped(field.value, variables)
            );
        case Kind.VARIABLE:
            return variables?.[valueNode.name.value];
    }
    invariant(false, 'Unexpected value node: ' + inspect(valueNode));
}
function isType(type11) {
    return isScalarType(type11) || isObjectType(type11) || isInterfaceType(type11) || isUnionType(type11) || isEnumType(type11) || isInputObjectType(type11) || isListType(type11) || isNonNullType(type11);
}
function assertType(type12) {
    if (!isType(type12)) {
        throw new Error(`Expected ${inspect(type12)} to be a GraphQL type.`);
    }
    return type12;
}
function isScalarType(type13) {
    return __default(type13, GraphQLScalarType);
}
function isObjectType(type14) {
    return __default(type14, GraphQLObjectType);
}
function isInterfaceType(type15) {
    return __default(type15, GraphQLInterfaceType);
}
function isUnionType(type16) {
    return __default(type16, GraphQLUnionType);
}
function isEnumType(type17) {
    return __default(type17, GraphQLEnumType);
}
function isInputObjectType(type18) {
    return __default(type18, GraphQLInputObjectType);
}
function isListType(type19) {
    return __default(type19, GraphQLList);
}
function isNonNullType(type20) {
    return __default(type20, GraphQLNonNull);
}
function isInputType(type21) {
    return isScalarType(type21) || isEnumType(type21) || isInputObjectType(type21) || isWrappingType(type21) && isInputType(type21.ofType);
}
function isOutputType(type22) {
    return isScalarType(type22) || isObjectType(type22) || isInterfaceType(type22) || isUnionType(type22) || isEnumType(type22) || isWrappingType(type22) && isOutputType(type22.ofType);
}
function isLeafType(type23) {
    return isScalarType(type23) || isEnumType(type23);
}
function isCompositeType(type24) {
    return isObjectType(type24) || isInterfaceType(type24) || isUnionType(type24);
}
function isAbstractType(type25) {
    return isInterfaceType(type25) || isUnionType(type25);
}
function GraphQLList(ofType) {
    if (this instanceof GraphQLList) {
        this.ofType = assertType(ofType);
    } else {
        return new GraphQLList(ofType);
    }
}
GraphQLList.prototype.toString = function toString() {
    return '[' + String(this.ofType) + ']';
};
Object.defineProperty(GraphQLList.prototype, SYMBOL_TO_STRING_TAG, {
    get () {
        return 'GraphQLList';
    }
});
defineToJSON(GraphQLList);
function GraphQLNonNull(ofType) {
    if (this instanceof GraphQLNonNull) {
        this.ofType = assertNullableType(ofType);
    } else {
        return new GraphQLNonNull(ofType);
    }
}
GraphQLNonNull.prototype.toString = function toString() {
    return String(this.ofType) + '!';
};
Object.defineProperty(GraphQLNonNull.prototype, SYMBOL_TO_STRING_TAG, {
    get () {
        return 'GraphQLNonNull';
    }
});
defineToJSON(GraphQLNonNull);
function isWrappingType(type26) {
    return isListType(type26) || isNonNullType(type26);
}
function isNullableType(type27) {
    return isType(type27) && !isNonNullType(type27);
}
function assertNullableType(type28) {
    if (!isNullableType(type28)) {
        throw new Error(`Expected ${inspect(type28)} to be a GraphQL nullable type.`);
    }
    return type28;
}
function getNullableType(type29) {
    if (type29) {
        return isNonNullType(type29) ? type29.ofType : type29;
    }
}
function isNamedType(type30) {
    return isScalarType(type30) || isObjectType(type30) || isInterfaceType(type30) || isUnionType(type30) || isEnumType(type30) || isInputObjectType(type30);
}
function getNamedType(type31) {
    if (type31) {
        let unwrappedType = type31;
        while(isWrappingType(unwrappedType)){
            unwrappedType = unwrappedType.ofType;
        }
        return unwrappedType;
    }
}
function resolveThunk(thunk) {
    return typeof thunk === 'function' ? thunk() : thunk;
}
function undefineIfEmpty(arr) {
    return arr && arr.length > 0 ? arr : undefined;
}
class GraphQLScalarType {
    constructor(config){
        const parseValue = config.parseValue ?? identityFunc;
        this.name = config.name;
        this.description = config.description;
        this.serialize = config.serialize ?? identityFunc;
        this.parseValue = parseValue;
        this.parseLiteral = config.parseLiteral ?? ((node)=>parseValue(valueFromASTUntyped(node))
        );
        this.extensions = config.extensions && toObjMap(config.extensions);
        this.astNode = config.astNode;
        this.extensionASTNodes = undefineIfEmpty(config.extensionASTNodes);
        devAssert(typeof config.name === 'string', 'Must provide name.');
        devAssert(config.serialize == null || typeof config.serialize === 'function', `${this.name} must provide "serialize" function. If this custom Scalar is also used as an input type, ensure "parseValue" and "parseLiteral" functions are also provided.`);
        if (config.parseLiteral) {
            devAssert(typeof config.parseValue === 'function' && typeof config.parseLiteral === 'function', `${this.name} must provide both "parseValue" and "parseLiteral" functions.`);
        }
    }
    toConfig() {
        return {
            name: this.name,
            description: this.description,
            serialize: this.serialize,
            parseValue: this.parseValue,
            parseLiteral: this.parseLiteral,
            extensions: this.extensions,
            astNode: this.astNode,
            extensionASTNodes: this.extensionASTNodes ?? []
        };
    }
    toString() {
        return this.name;
    }
    get [SYMBOL_TO_STRING_TAG]() {
        return 'GraphQLScalarType';
    }
}
defineToJSON(GraphQLScalarType);
class GraphQLObjectType {
    constructor(config){
        this.name = config.name;
        this.description = config.description;
        this.isTypeOf = config.isTypeOf;
        this.extensions = config.extensions && toObjMap(config.extensions);
        this.astNode = config.astNode;
        this.extensionASTNodes = undefineIfEmpty(config.extensionASTNodes);
        this._fields = defineFieldMap.bind(undefined, config);
        this._interfaces = defineInterfaces.bind(undefined, config);
        devAssert(typeof config.name === 'string', 'Must provide name.');
        devAssert(config.isTypeOf == null || typeof config.isTypeOf === 'function', `${this.name} must provide "isTypeOf" as a function, ` + `but got: ${inspect(config.isTypeOf)}.`);
    }
    getFields() {
        if (typeof this._fields === 'function') {
            this._fields = this._fields();
        }
        return this._fields;
    }
    getInterfaces() {
        if (typeof this._interfaces === 'function') {
            this._interfaces = this._interfaces();
        }
        return this._interfaces;
    }
    toConfig() {
        return {
            name: this.name,
            description: this.description,
            interfaces: this.getInterfaces(),
            fields: fieldsToFieldsConfig(this.getFields()),
            isTypeOf: this.isTypeOf,
            extensions: this.extensions,
            astNode: this.astNode,
            extensionASTNodes: this.extensionASTNodes || []
        };
    }
    toString() {
        return this.name;
    }
    get [SYMBOL_TO_STRING_TAG]() {
        return 'GraphQLObjectType';
    }
}
defineToJSON(GraphQLObjectType);
function defineInterfaces(config) {
    const interfaces = resolveThunk(config.interfaces) ?? [];
    devAssert(Array.isArray(interfaces), `${config.name} interfaces must be an Array or a function which returns an Array.`);
    return interfaces;
}
function defineFieldMap(config) {
    const fieldMap = resolveThunk(config.fields);
    devAssert(isPlainObj(fieldMap), `${config.name} fields must be an object with field names as keys or a function which returns such an object.`);
    return mapValue(fieldMap, (fieldConfig, fieldName)=>{
        devAssert(isPlainObj(fieldConfig), `${config.name}.${fieldName} field config must be an object.`);
        devAssert(!('isDeprecated' in fieldConfig), `${config.name}.${fieldName} should provide "deprecationReason" instead of "isDeprecated".`);
        devAssert(fieldConfig.resolve == null || typeof fieldConfig.resolve === 'function', `${config.name}.${fieldName} field resolver must be a function if ` + `provided, but got: ${inspect(fieldConfig.resolve)}.`);
        const argsConfig = fieldConfig.args ?? {};
        devAssert(isPlainObj(argsConfig), `${config.name}.${fieldName} args must be an object with argument names as keys.`);
        const args = objectEntries(argsConfig).map(([argName, argConfig])=>({
                name: argName,
                description: argConfig.description,
                type: argConfig.type,
                defaultValue: argConfig.defaultValue,
                extensions: argConfig.extensions && toObjMap(argConfig.extensions),
                astNode: argConfig.astNode
            })
        );
        return {
            name: fieldName,
            description: fieldConfig.description,
            type: fieldConfig.type,
            args,
            resolve: fieldConfig.resolve,
            subscribe: fieldConfig.subscribe,
            isDeprecated: fieldConfig.deprecationReason != null,
            deprecationReason: fieldConfig.deprecationReason,
            extensions: fieldConfig.extensions && toObjMap(fieldConfig.extensions),
            astNode: fieldConfig.astNode
        };
    });
}
function isPlainObj(obj) {
    return isObjectLike(obj) && !Array.isArray(obj);
}
function fieldsToFieldsConfig(fields) {
    return mapValue(fields, (field)=>({
            description: field.description,
            type: field.type,
            args: argsToArgsConfig(field.args),
            resolve: field.resolve,
            subscribe: field.subscribe,
            deprecationReason: field.deprecationReason,
            extensions: field.extensions,
            astNode: field.astNode
        })
    );
}
function argsToArgsConfig(args) {
    return keyValMap(args, (arg)=>arg.name
    , (arg)=>({
            description: arg.description,
            type: arg.type,
            defaultValue: arg.defaultValue,
            extensions: arg.extensions,
            astNode: arg.astNode
        })
    );
}
function isRequiredArgument(arg) {
    return isNonNullType(arg.type) && arg.defaultValue === undefined;
}
class GraphQLInterfaceType {
    constructor(config){
        this.name = config.name;
        this.description = config.description;
        this.resolveType = config.resolveType;
        this.extensions = config.extensions && toObjMap(config.extensions);
        this.astNode = config.astNode;
        this.extensionASTNodes = undefineIfEmpty(config.extensionASTNodes);
        this._fields = defineFieldMap.bind(undefined, config);
        this._interfaces = defineInterfaces.bind(undefined, config);
        devAssert(typeof config.name === 'string', 'Must provide name.');
        devAssert(config.resolveType == null || typeof config.resolveType === 'function', `${this.name} must provide "resolveType" as a function, ` + `but got: ${inspect(config.resolveType)}.`);
    }
    getFields() {
        if (typeof this._fields === 'function') {
            this._fields = this._fields();
        }
        return this._fields;
    }
    getInterfaces() {
        if (typeof this._interfaces === 'function') {
            this._interfaces = this._interfaces();
        }
        return this._interfaces;
    }
    toConfig() {
        return {
            name: this.name,
            description: this.description,
            interfaces: this.getInterfaces(),
            fields: fieldsToFieldsConfig(this.getFields()),
            resolveType: this.resolveType,
            extensions: this.extensions,
            astNode: this.astNode,
            extensionASTNodes: this.extensionASTNodes ?? []
        };
    }
    toString() {
        return this.name;
    }
    get [SYMBOL_TO_STRING_TAG]() {
        return 'GraphQLInterfaceType';
    }
}
defineToJSON(GraphQLInterfaceType);
class GraphQLUnionType {
    constructor(config){
        this.name = config.name;
        this.description = config.description;
        this.resolveType = config.resolveType;
        this.extensions = config.extensions && toObjMap(config.extensions);
        this.astNode = config.astNode;
        this.extensionASTNodes = undefineIfEmpty(config.extensionASTNodes);
        this._types = defineTypes.bind(undefined, config);
        devAssert(typeof config.name === 'string', 'Must provide name.');
        devAssert(config.resolveType == null || typeof config.resolveType === 'function', `${this.name} must provide "resolveType" as a function, ` + `but got: ${inspect(config.resolveType)}.`);
    }
    getTypes() {
        if (typeof this._types === 'function') {
            this._types = this._types();
        }
        return this._types;
    }
    toConfig() {
        return {
            name: this.name,
            description: this.description,
            types: this.getTypes(),
            resolveType: this.resolveType,
            extensions: this.extensions,
            astNode: this.astNode,
            extensionASTNodes: this.extensionASTNodes ?? []
        };
    }
    toString() {
        return this.name;
    }
    get [SYMBOL_TO_STRING_TAG]() {
        return 'GraphQLUnionType';
    }
}
defineToJSON(GraphQLUnionType);
function defineTypes(config) {
    const types = resolveThunk(config.types);
    devAssert(Array.isArray(types), `Must provide Array of types or a function which returns such an array for Union ${config.name}.`);
    return types;
}
class GraphQLEnumType {
    constructor(config){
        this.name = config.name;
        this.description = config.description;
        this.extensions = config.extensions && toObjMap(config.extensions);
        this.astNode = config.astNode;
        this.extensionASTNodes = undefineIfEmpty(config.extensionASTNodes);
        this._values = defineEnumValues(this.name, config.values);
        this._valueLookup = new Map(this._values.map((enumValue)=>[
                enumValue.value,
                enumValue
            ]
        ));
        this._nameLookup = keyMap(this._values, (value)=>value.name
        );
        devAssert(typeof config.name === 'string', 'Must provide name.');
    }
    getValues() {
        return this._values;
    }
    getValue(name) {
        return this._nameLookup[name];
    }
    serialize(outputValue) {
        const enumValue = this._valueLookup.get(outputValue);
        if (enumValue === undefined) {
            throw new GraphQLError(`Enum "${this.name}" cannot represent value: ${inspect(outputValue)}`);
        }
        return enumValue.name;
    }
    parseValue(inputValue) {
        if (typeof inputValue !== 'string') {
            const valueStr = inspect(inputValue);
            throw new GraphQLError(`Enum "${this.name}" cannot represent non-string value: ${valueStr}.` + didYouMeanEnumValue(this, valueStr));
        }
        const enumValue = this.getValue(inputValue);
        if (enumValue == null) {
            throw new GraphQLError(`Value "${inputValue}" does not exist in "${this.name}" enum.` + didYouMeanEnumValue(this, inputValue));
        }
        return enumValue.value;
    }
    parseLiteral(valueNode, _variables) {
        if (valueNode.kind !== Kind.ENUM) {
            const valueStr = print(valueNode);
            throw new GraphQLError(`Enum "${this.name}" cannot represent non-enum value: ${valueStr}.` + didYouMeanEnumValue(this, valueStr), valueNode);
        }
        const enumValue = this.getValue(valueNode.value);
        if (enumValue == null) {
            const valueStr = print(valueNode);
            throw new GraphQLError(`Value "${valueStr}" does not exist in "${this.name}" enum.` + didYouMeanEnumValue(this, valueStr), valueNode);
        }
        return enumValue.value;
    }
    toConfig() {
        const values6 = keyValMap(this.getValues(), (value)=>value.name
        , (value)=>({
                description: value.description,
                value: value.value,
                deprecationReason: value.deprecationReason,
                extensions: value.extensions,
                astNode: value.astNode
            })
        );
        return {
            name: this.name,
            description: this.description,
            values: values6,
            extensions: this.extensions,
            astNode: this.astNode,
            extensionASTNodes: this.extensionASTNodes ?? []
        };
    }
    toString() {
        return this.name;
    }
    get [SYMBOL_TO_STRING_TAG]() {
        return 'GraphQLEnumType';
    }
}
defineToJSON(GraphQLEnumType);
function didYouMeanEnumValue(enumType, unknownValueStr) {
    const allNames = enumType.getValues().map((value)=>value.name
    );
    const suggestedValues = suggestionList(unknownValueStr, allNames);
    return didYouMean('the enum value', suggestedValues);
}
function defineEnumValues(typeName, valueMap) {
    devAssert(isPlainObj(valueMap), `${typeName} values must be an object with value names as keys.`);
    return objectEntries(valueMap).map(([valueName, valueConfig])=>{
        devAssert(isPlainObj(valueConfig), `${typeName}.${valueName} must refer to an object with a "value" key ` + `representing an internal value but got: ${inspect(valueConfig)}.`);
        devAssert(!('isDeprecated' in valueConfig), `${typeName}.${valueName} should provide "deprecationReason" instead of "isDeprecated".`);
        return {
            name: valueName,
            description: valueConfig.description,
            value: valueConfig.value !== undefined ? valueConfig.value : valueName,
            isDeprecated: valueConfig.deprecationReason != null,
            deprecationReason: valueConfig.deprecationReason,
            extensions: valueConfig.extensions && toObjMap(valueConfig.extensions),
            astNode: valueConfig.astNode
        };
    });
}
class GraphQLInputObjectType {
    constructor(config){
        this.name = config.name;
        this.description = config.description;
        this.extensions = config.extensions && toObjMap(config.extensions);
        this.astNode = config.astNode;
        this.extensionASTNodes = undefineIfEmpty(config.extensionASTNodes);
        this._fields = defineInputFieldMap.bind(undefined, config);
        devAssert(typeof config.name === 'string', 'Must provide name.');
    }
    getFields() {
        if (typeof this._fields === 'function') {
            this._fields = this._fields();
        }
        return this._fields;
    }
    toConfig() {
        const fields = mapValue(this.getFields(), (field)=>({
                description: field.description,
                type: field.type,
                defaultValue: field.defaultValue,
                extensions: field.extensions,
                astNode: field.astNode
            })
        );
        return {
            name: this.name,
            description: this.description,
            fields,
            extensions: this.extensions,
            astNode: this.astNode,
            extensionASTNodes: this.extensionASTNodes ?? []
        };
    }
    toString() {
        return this.name;
    }
    get [SYMBOL_TO_STRING_TAG]() {
        return 'GraphQLInputObjectType';
    }
}
defineToJSON(GraphQLInputObjectType);
function defineInputFieldMap(config) {
    const fieldMap = resolveThunk(config.fields);
    devAssert(isPlainObj(fieldMap), `${config.name} fields must be an object with field names as keys or a function which returns such an object.`);
    return mapValue(fieldMap, (fieldConfig, fieldName)=>{
        devAssert(!('resolve' in fieldConfig), `${config.name}.${fieldName} field has a resolve property, but Input Types cannot define resolvers.`);
        return {
            name: fieldName,
            description: fieldConfig.description,
            type: fieldConfig.type,
            defaultValue: fieldConfig.defaultValue,
            extensions: fieldConfig.extensions && toObjMap(fieldConfig.extensions),
            astNode: fieldConfig.astNode
        };
    });
}
function isRequiredInputField(field) {
    return isNonNullType(field.type) && field.defaultValue === undefined;
}
function isEqualType(typeA, typeB) {
    if (typeA === typeB) {
        return true;
    }
    if (isNonNullType(typeA) && isNonNullType(typeB)) {
        return isEqualType(typeA.ofType, typeB.ofType);
    }
    if (isListType(typeA) && isListType(typeB)) {
        return isEqualType(typeA.ofType, typeB.ofType);
    }
    return false;
}
function isTypeSubTypeOf(schema, maybeSubType, superType) {
    if (maybeSubType === superType) {
        return true;
    }
    if (isNonNullType(superType)) {
        if (isNonNullType(maybeSubType)) {
            return isTypeSubTypeOf(schema, maybeSubType.ofType, superType.ofType);
        }
        return false;
    }
    if (isNonNullType(maybeSubType)) {
        return isTypeSubTypeOf(schema, maybeSubType.ofType, superType);
    }
    if (isListType(superType)) {
        if (isListType(maybeSubType)) {
            return isTypeSubTypeOf(schema, maybeSubType.ofType, superType.ofType);
        }
        return false;
    }
    if (isListType(maybeSubType)) {
        return false;
    }
    return isAbstractType(superType) && (isInterfaceType(maybeSubType) || isObjectType(maybeSubType)) && schema.isSubType(superType, maybeSubType);
}
function doTypesOverlap(schema, typeA, typeB) {
    if (typeA === typeB) {
        return true;
    }
    if (isAbstractType(typeA)) {
        if (isAbstractType(typeB)) {
            return schema.getPossibleTypes(typeA).some((type32)=>schema.isSubType(typeB, type32)
            );
        }
        return schema.isSubType(typeA, typeB);
    }
    if (isAbstractType(typeB)) {
        return schema.isSubType(typeB, typeA);
    }
    return false;
}
const isFinitePolyfill = Number.isFinite || function(value) {
    return typeof value === 'number' && isFinite(value);
};
const isInteger = Number.isInteger || function(value) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
};
const MIN_INT = -2147483648;
function serializeInt(outputValue) {
    const coercedValue = serializeObject(outputValue);
    if (typeof coercedValue === 'boolean') {
        return coercedValue ? 1 : 0;
    }
    let num = coercedValue;
    if (typeof coercedValue === 'string' && coercedValue !== '') {
        num = Number(coercedValue);
    }
    if (!isInteger(num)) {
        throw new GraphQLError(`Int cannot represent non-integer value: ${inspect(coercedValue)}`);
    }
    if (num > 2147483647 || num < MIN_INT) {
        throw new GraphQLError('Int cannot represent non 32-bit signed integer value: ' + inspect(coercedValue));
    }
    return num;
}
function coerceInt(inputValue) {
    if (!isInteger(inputValue)) {
        throw new GraphQLError(`Int cannot represent non-integer value: ${inspect(inputValue)}`);
    }
    if (inputValue > 2147483647 || inputValue < MIN_INT) {
        throw new GraphQLError(`Int cannot represent non 32-bit signed integer value: ${inputValue}`);
    }
    return inputValue;
}
const GraphQLInt = new GraphQLScalarType({
    name: 'Int',
    description: 'The `Int` scalar type represents non-fractional signed whole numeric values. Int can represent values between -(2^31) and 2^31 - 1.',
    serialize: serializeInt,
    parseValue: coerceInt,
    parseLiteral (valueNode) {
        if (valueNode.kind !== Kind.INT) {
            throw new GraphQLError(`Int cannot represent non-integer value: ${print(valueNode)}`, valueNode);
        }
        const num = parseInt(valueNode.value, 10);
        if (num > 2147483647 || num < MIN_INT) {
            throw new GraphQLError(`Int cannot represent non 32-bit signed integer value: ${valueNode.value}`, valueNode);
        }
        return num;
    }
});
function serializeFloat(outputValue) {
    const coercedValue = serializeObject(outputValue);
    if (typeof coercedValue === 'boolean') {
        return coercedValue ? 1 : 0;
    }
    let num = coercedValue;
    if (typeof coercedValue === 'string' && coercedValue !== '') {
        num = Number(coercedValue);
    }
    if (!isFinitePolyfill(num)) {
        throw new GraphQLError(`Float cannot represent non numeric value: ${inspect(coercedValue)}`);
    }
    return num;
}
function coerceFloat(inputValue) {
    if (!isFinitePolyfill(inputValue)) {
        throw new GraphQLError(`Float cannot represent non numeric value: ${inspect(inputValue)}`);
    }
    return inputValue;
}
const GraphQLFloat = new GraphQLScalarType({
    name: 'Float',
    description: 'The `Float` scalar type represents signed double-precision fractional values as specified by [IEEE 754](https://en.wikipedia.org/wiki/IEEE_floating_point).',
    serialize: serializeFloat,
    parseValue: coerceFloat,
    parseLiteral (valueNode) {
        if (valueNode.kind !== Kind.FLOAT && valueNode.kind !== Kind.INT) {
            throw new GraphQLError(`Float cannot represent non numeric value: ${print(valueNode)}`, valueNode);
        }
        return parseFloat(valueNode.value);
    }
});
function serializeObject(outputValue) {
    if (isObjectLike(outputValue)) {
        if (typeof outputValue.valueOf === 'function') {
            const valueOfResult = outputValue.valueOf();
            if (!isObjectLike(valueOfResult)) {
                return valueOfResult;
            }
        }
        if (typeof outputValue.toJSON === 'function') {
            return outputValue.toJSON();
        }
    }
    return outputValue;
}
function serializeString(outputValue) {
    const coercedValue = serializeObject(outputValue);
    if (typeof coercedValue === 'string') {
        return coercedValue;
    }
    if (typeof coercedValue === 'boolean') {
        return coercedValue ? 'true' : 'false';
    }
    if (isFinitePolyfill(coercedValue)) {
        return coercedValue.toString();
    }
    throw new GraphQLError(`String cannot represent value: ${inspect(outputValue)}`);
}
function coerceString(inputValue) {
    if (typeof inputValue !== 'string') {
        throw new GraphQLError(`String cannot represent a non string value: ${inspect(inputValue)}`);
    }
    return inputValue;
}
const GraphQLString = new GraphQLScalarType({
    name: 'String',
    description: 'The `String` scalar type represents textual data, represented as UTF-8 character sequences. The String type is most often used by GraphQL to represent free-form human-readable text.',
    serialize: serializeString,
    parseValue: coerceString,
    parseLiteral (valueNode) {
        if (valueNode.kind !== Kind.STRING) {
            throw new GraphQLError(`String cannot represent a non string value: ${print(valueNode)}`, valueNode);
        }
        return valueNode.value;
    }
});
function serializeBoolean(outputValue) {
    const coercedValue = serializeObject(outputValue);
    if (typeof coercedValue === 'boolean') {
        return coercedValue;
    }
    if (isFinitePolyfill(coercedValue)) {
        return coercedValue !== 0;
    }
    throw new GraphQLError(`Boolean cannot represent a non boolean value: ${inspect(coercedValue)}`);
}
function coerceBoolean(inputValue) {
    if (typeof inputValue !== 'boolean') {
        throw new GraphQLError(`Boolean cannot represent a non boolean value: ${inspect(inputValue)}`);
    }
    return inputValue;
}
const GraphQLBoolean = new GraphQLScalarType({
    name: 'Boolean',
    description: 'The `Boolean` scalar type represents `true` or `false`.',
    serialize: serializeBoolean,
    parseValue: coerceBoolean,
    parseLiteral (valueNode) {
        if (valueNode.kind !== Kind.BOOLEAN) {
            throw new GraphQLError(`Boolean cannot represent a non boolean value: ${print(valueNode)}`, valueNode);
        }
        return valueNode.value;
    }
});
function serializeID(outputValue) {
    const coercedValue = serializeObject(outputValue);
    if (typeof coercedValue === 'string') {
        return coercedValue;
    }
    if (isInteger(coercedValue)) {
        return String(coercedValue);
    }
    throw new GraphQLError(`ID cannot represent value: ${inspect(outputValue)}`);
}
function coerceID(inputValue) {
    if (typeof inputValue === 'string') {
        return inputValue;
    }
    if (isInteger(inputValue)) {
        return inputValue.toString();
    }
    throw new GraphQLError(`ID cannot represent value: ${inspect(inputValue)}`);
}
const GraphQLID = new GraphQLScalarType({
    name: 'ID',
    description: 'The `ID` scalar type represents a unique identifier, often used to refetch an object or as key for a cache. The ID type appears in a JSON response as a String; however, it is not intended to be human-readable. When expected as an input type, any string (such as `"4"`) or integer (such as `4`) input value will be accepted as an ID.',
    serialize: serializeID,
    parseValue: coerceID,
    parseLiteral (valueNode) {
        if (valueNode.kind !== Kind.STRING && valueNode.kind !== Kind.INT) {
            throw new GraphQLError('ID cannot represent a non-string and non-integer value: ' + print(valueNode), valueNode);
        }
        return valueNode.value;
    }
});
const specifiedScalarTypes = Object.freeze([
    GraphQLString,
    GraphQLInt,
    GraphQLFloat,
    GraphQLBoolean,
    GraphQLID
]);
function isSpecifiedScalarType(type33) {
    return specifiedScalarTypes.some(({ name  })=>type33.name === name
    );
}
function isDirective(directive) {
    return __default(directive, GraphQLDirective);
}
class GraphQLDirective {
    constructor(config){
        this.name = config.name;
        this.description = config.description;
        this.locations = config.locations;
        this.isRepeatable = config.isRepeatable ?? false;
        this.extensions = config.extensions && toObjMap(config.extensions);
        this.astNode = config.astNode;
        devAssert(config.name, 'Directive must be named.');
        devAssert(Array.isArray(config.locations), `@${config.name} locations must be an Array.`);
        const args = config.args ?? {};
        devAssert(isObjectLike(args) && !Array.isArray(args), `@${config.name} args must be an object with argument names as keys.`);
        this.args = objectEntries(args).map(([argName, argConfig])=>({
                name: argName,
                description: argConfig.description,
                type: argConfig.type,
                defaultValue: argConfig.defaultValue,
                extensions: argConfig.extensions && toObjMap(argConfig.extensions),
                astNode: argConfig.astNode
            })
        );
    }
    toConfig() {
        return {
            name: this.name,
            description: this.description,
            locations: this.locations,
            args: argsToArgsConfig(this.args),
            isRepeatable: this.isRepeatable,
            extensions: this.extensions,
            astNode: this.astNode
        };
    }
    toString() {
        return '@' + this.name;
    }
    get [SYMBOL_TO_STRING_TAG]() {
        return 'GraphQLDirective';
    }
}
defineToJSON(GraphQLDirective);
const GraphQLIncludeDirective = new GraphQLDirective({
    name: 'include',
    description: 'Directs the executor to include this field or fragment only when the `if` argument is true.',
    locations: [
        DirectiveLocation.FIELD,
        DirectiveLocation.FRAGMENT_SPREAD,
        DirectiveLocation.INLINE_FRAGMENT
    ],
    args: {
        if: {
            type: GraphQLNonNull(GraphQLBoolean),
            description: 'Included when true.'
        }
    }
});
const GraphQLSkipDirective = new GraphQLDirective({
    name: 'skip',
    description: 'Directs the executor to skip this field or fragment when the `if` argument is true.',
    locations: [
        DirectiveLocation.FIELD,
        DirectiveLocation.FRAGMENT_SPREAD,
        DirectiveLocation.INLINE_FRAGMENT
    ],
    args: {
        if: {
            type: GraphQLNonNull(GraphQLBoolean),
            description: 'Skipped when true.'
        }
    }
});
const DEFAULT_DEPRECATION_REASON = 'No longer supported';
const GraphQLDeprecatedDirective = new GraphQLDirective({
    name: 'deprecated',
    description: 'Marks an element of a GraphQL schema as no longer supported.',
    locations: [
        DirectiveLocation.FIELD_DEFINITION,
        DirectiveLocation.ENUM_VALUE
    ],
    args: {
        reason: {
            type: GraphQLString,
            description: 'Explains why this element was deprecated, usually also including a suggestion for how to access supported similar data. Formatted using the Markdown syntax, as specified by [CommonMark](https://commonmark.org/).',
            defaultValue: DEFAULT_DEPRECATION_REASON
        }
    }
});
const specifiedDirectives = Object.freeze([
    GraphQLIncludeDirective,
    GraphQLSkipDirective,
    GraphQLDeprecatedDirective
]);
const arrayFrom = Array.from || function(obj, mapFn, thisArg) {
    if (obj == null) {
        throw new TypeError('Array.from requires an array-like object - not null or undefined');
    }
    const iteratorMethod = obj[SYMBOL_ITERATOR];
    if (typeof iteratorMethod === 'function') {
        const iterator = iteratorMethod.call(obj);
        const result = [];
        let step;
        for(let i12 = 0; !(step = iterator.next()).done; ++i12){
            result.push(mapFn.call(thisArg, step.value, i12));
            if (i12 > 9999999) {
                throw new TypeError('Near-infinite iteration.');
            }
        }
        return result;
    }
    const length1 = obj.length;
    if (typeof length1 === 'number' && length1 >= 0 && length1 % 1 === 0) {
        const result = [];
        for(let i13 = 0; i13 < length1; ++i13){
            if (Object.prototype.hasOwnProperty.call(obj, i13)) {
                result.push(mapFn.call(thisArg, obj[i13], i13));
            }
        }
        return result;
    }
    return [];
};
function isCollection(obj) {
    if (obj == null || typeof obj !== 'object') {
        return false;
    }
    const length2 = obj.length;
    if (typeof length2 === 'number' && length2 >= 0 && length2 % 1 === 0) {
        return true;
    }
    return typeof obj[SYMBOL_ITERATOR] === 'function';
}
function astFromValue(value, type34) {
    if (isNonNullType(type34)) {
        const astValue = astFromValue(value, type34.ofType);
        if (astValue?.kind === Kind.NULL) {
            return null;
        }
        return astValue;
    }
    if (value === null) {
        return {
            kind: Kind.NULL
        };
    }
    if (value === undefined) {
        return null;
    }
    if (isListType(type34)) {
        const itemType = type34.ofType;
        if (isCollection(value)) {
            const valuesNodes = [];
            for (const item of arrayFrom(value)){
                const itemNode = astFromValue(item, itemType);
                if (itemNode != null) {
                    valuesNodes.push(itemNode);
                }
            }
            return {
                kind: Kind.LIST,
                values: valuesNodes
            };
        }
        return astFromValue(value, itemType);
    }
    if (isInputObjectType(type34)) {
        if (!isObjectLike(value)) {
            return null;
        }
        const fieldNodes = [];
        for (const field of objectValues(type34.getFields())){
            const fieldValue = astFromValue(value[field.name], field.type);
            if (fieldValue) {
                fieldNodes.push({
                    kind: Kind.OBJECT_FIELD,
                    name: {
                        kind: Kind.NAME,
                        value: field.name
                    },
                    value: fieldValue
                });
            }
        }
        return {
            kind: Kind.OBJECT,
            fields: fieldNodes
        };
    }
    if (isLeafType(type34)) {
        const serialized = type34.serialize(value);
        if (serialized == null) {
            return null;
        }
        if (typeof serialized === 'boolean') {
            return {
                kind: Kind.BOOLEAN,
                value: serialized
            };
        }
        if (typeof serialized === 'number' && isFinitePolyfill(serialized)) {
            const stringNum = String(serialized);
            return integerStringRegExp.test(stringNum) ? {
                kind: Kind.INT,
                value: stringNum
            } : {
                kind: Kind.FLOAT,
                value: stringNum
            };
        }
        if (typeof serialized === 'string') {
            if (isEnumType(type34)) {
                return {
                    kind: Kind.ENUM,
                    value: serialized
                };
            }
            if (type34 === GraphQLID && integerStringRegExp.test(serialized)) {
                return {
                    kind: Kind.INT,
                    value: serialized
                };
            }
            return {
                kind: Kind.STRING,
                value: serialized
            };
        }
        throw new TypeError(`Cannot convert value to AST: ${inspect(serialized)}.`);
    }
    invariant(false, 'Unexpected input type: ' + inspect(type34));
}
const integerStringRegExp = /^-?(?:0|[1-9][0-9]*)$/;
const __Schema = new GraphQLObjectType({
    name: '__Schema',
    description: 'A GraphQL Schema defines the capabilities of a GraphQL server. It exposes all available types and directives on the server, as well as the entry points for query, mutation, and subscription operations.',
    fields: ()=>({
            description: {
                type: GraphQLString,
                resolve: (schema)=>schema.description
            },
            types: {
                description: 'A list of all types supported by this server.',
                type: GraphQLNonNull(GraphQLList(GraphQLNonNull(__Type))),
                resolve (schema) {
                    return objectValues(schema.getTypeMap());
                }
            },
            queryType: {
                description: 'The type that query operations will be rooted at.',
                type: GraphQLNonNull(__Type),
                resolve: (schema)=>schema.getQueryType()
            },
            mutationType: {
                description: 'If this server supports mutation, the type that mutation operations will be rooted at.',
                type: __Type,
                resolve: (schema)=>schema.getMutationType()
            },
            subscriptionType: {
                description: 'If this server support subscription, the type that subscription operations will be rooted at.',
                type: __Type,
                resolve: (schema)=>schema.getSubscriptionType()
            },
            directives: {
                description: 'A list of all directives supported by this server.',
                type: GraphQLNonNull(GraphQLList(GraphQLNonNull(__Directive))),
                resolve: (schema)=>schema.getDirectives()
            }
        })
});
const __Directive = new GraphQLObjectType({
    name: '__Directive',
    description: "A Directive provides a way to describe alternate runtime execution and type validation behavior in a GraphQL document.\n\nIn some cases, you need to provide options to alter GraphQL's execution behavior in ways field arguments will not suffice, such as conditionally including or skipping a field. Directives provide this by describing additional information to the executor.",
    fields: ()=>({
            name: {
                type: GraphQLNonNull(GraphQLString),
                resolve: (directive)=>directive.name
            },
            description: {
                type: GraphQLString,
                resolve: (directive)=>directive.description
            },
            isRepeatable: {
                type: GraphQLNonNull(GraphQLBoolean),
                resolve: (directive)=>directive.isRepeatable
            },
            locations: {
                type: GraphQLNonNull(GraphQLList(GraphQLNonNull(__DirectiveLocation))),
                resolve: (directive)=>directive.locations
            },
            args: {
                type: GraphQLNonNull(GraphQLList(GraphQLNonNull(__InputValue))),
                resolve: (directive)=>directive.args
            }
        })
});
const __DirectiveLocation = new GraphQLEnumType({
    name: '__DirectiveLocation',
    description: 'A Directive can be adjacent to many parts of the GraphQL language, a __DirectiveLocation describes one such possible adjacencies.',
    values: {
        QUERY: {
            value: DirectiveLocation.QUERY,
            description: 'Location adjacent to a query operation.'
        },
        MUTATION: {
            value: DirectiveLocation.MUTATION,
            description: 'Location adjacent to a mutation operation.'
        },
        SUBSCRIPTION: {
            value: DirectiveLocation.SUBSCRIPTION,
            description: 'Location adjacent to a subscription operation.'
        },
        FIELD: {
            value: DirectiveLocation.FIELD,
            description: 'Location adjacent to a field.'
        },
        FRAGMENT_DEFINITION: {
            value: DirectiveLocation.FRAGMENT_DEFINITION,
            description: 'Location adjacent to a fragment definition.'
        },
        FRAGMENT_SPREAD: {
            value: DirectiveLocation.FRAGMENT_SPREAD,
            description: 'Location adjacent to a fragment spread.'
        },
        INLINE_FRAGMENT: {
            value: DirectiveLocation.INLINE_FRAGMENT,
            description: 'Location adjacent to an inline fragment.'
        },
        VARIABLE_DEFINITION: {
            value: DirectiveLocation.VARIABLE_DEFINITION,
            description: 'Location adjacent to a variable definition.'
        },
        SCHEMA: {
            value: DirectiveLocation.SCHEMA,
            description: 'Location adjacent to a schema definition.'
        },
        SCALAR: {
            value: DirectiveLocation.SCALAR,
            description: 'Location adjacent to a scalar definition.'
        },
        OBJECT: {
            value: DirectiveLocation.OBJECT,
            description: 'Location adjacent to an object type definition.'
        },
        FIELD_DEFINITION: {
            value: DirectiveLocation.FIELD_DEFINITION,
            description: 'Location adjacent to a field definition.'
        },
        ARGUMENT_DEFINITION: {
            value: DirectiveLocation.ARGUMENT_DEFINITION,
            description: 'Location adjacent to an argument definition.'
        },
        INTERFACE: {
            value: DirectiveLocation.INTERFACE,
            description: 'Location adjacent to an interface definition.'
        },
        UNION: {
            value: DirectiveLocation.UNION,
            description: 'Location adjacent to a union definition.'
        },
        ENUM: {
            value: DirectiveLocation.ENUM,
            description: 'Location adjacent to an enum definition.'
        },
        ENUM_VALUE: {
            value: DirectiveLocation.ENUM_VALUE,
            description: 'Location adjacent to an enum value definition.'
        },
        INPUT_OBJECT: {
            value: DirectiveLocation.INPUT_OBJECT,
            description: 'Location adjacent to an input object type definition.'
        },
        INPUT_FIELD_DEFINITION: {
            value: DirectiveLocation.INPUT_FIELD_DEFINITION,
            description: 'Location adjacent to an input object field definition.'
        }
    }
});
const __Type = new GraphQLObjectType({
    name: '__Type',
    description: 'The fundamental unit of any GraphQL Schema is the type. There are many kinds of types in GraphQL as represented by the `__TypeKind` enum.\n\nDepending on the kind of a type, certain fields describe information about that type. Scalar types provide no information beyond a name and description, while Enum types provide their values. Object and Interface types provide the fields they describe. Abstract types, Union and Interface, provide the Object types possible at runtime. List and NonNull types compose other types.',
    fields: ()=>({
            kind: {
                type: GraphQLNonNull(__TypeKind),
                resolve (type35) {
                    if (isScalarType(type35)) {
                        return TypeKind.SCALAR;
                    }
                    if (isObjectType(type35)) {
                        return TypeKind.OBJECT;
                    }
                    if (isInterfaceType(type35)) {
                        return TypeKind.INTERFACE;
                    }
                    if (isUnionType(type35)) {
                        return TypeKind.UNION;
                    }
                    if (isEnumType(type35)) {
                        return TypeKind.ENUM;
                    }
                    if (isInputObjectType(type35)) {
                        return TypeKind.INPUT_OBJECT;
                    }
                    if (isListType(type35)) {
                        return TypeKind.LIST;
                    }
                    if (isNonNullType(type35)) {
                        return TypeKind.NON_NULL;
                    }
                    invariant(false, `Unexpected type: "${inspect(type35)}".`);
                }
            },
            name: {
                type: GraphQLString,
                resolve: (type36)=>type36.name !== undefined ? type36.name : undefined
            },
            description: {
                type: GraphQLString,
                resolve: (type37)=>type37.description !== undefined ? type37.description : undefined
            },
            fields: {
                type: GraphQLList(GraphQLNonNull(__Field)),
                args: {
                    includeDeprecated: {
                        type: GraphQLBoolean,
                        defaultValue: false
                    }
                },
                resolve (type38, { includeDeprecated  }) {
                    if (isObjectType(type38) || isInterfaceType(type38)) {
                        let fields = objectValues(type38.getFields());
                        if (!includeDeprecated) {
                            fields = fields.filter((field)=>!field.isDeprecated
                            );
                        }
                        return fields;
                    }
                    return null;
                }
            },
            interfaces: {
                type: GraphQLList(GraphQLNonNull(__Type)),
                resolve (type39) {
                    if (isObjectType(type39) || isInterfaceType(type39)) {
                        return type39.getInterfaces();
                    }
                }
            },
            possibleTypes: {
                type: GraphQLList(GraphQLNonNull(__Type)),
                resolve (type40, _args, _context, { schema  }) {
                    if (isAbstractType(type40)) {
                        return schema.getPossibleTypes(type40);
                    }
                }
            },
            enumValues: {
                type: GraphQLList(GraphQLNonNull(__EnumValue)),
                args: {
                    includeDeprecated: {
                        type: GraphQLBoolean,
                        defaultValue: false
                    }
                },
                resolve (type41, { includeDeprecated  }) {
                    if (isEnumType(type41)) {
                        let values7 = type41.getValues();
                        if (!includeDeprecated) {
                            values7 = values7.filter((value)=>!value.isDeprecated
                            );
                        }
                        return values7;
                    }
                }
            },
            inputFields: {
                type: GraphQLList(GraphQLNonNull(__InputValue)),
                resolve (type42) {
                    if (isInputObjectType(type42)) {
                        return objectValues(type42.getFields());
                    }
                }
            },
            ofType: {
                type: __Type,
                resolve: (type43)=>type43.ofType !== undefined ? type43.ofType : undefined
            }
        })
});
const __Field = new GraphQLObjectType({
    name: '__Field',
    description: 'Object and Interface types are described by a list of Fields, each of which has a name, potentially a list of arguments, and a return type.',
    fields: ()=>({
            name: {
                type: GraphQLNonNull(GraphQLString),
                resolve: (field)=>field.name
            },
            description: {
                type: GraphQLString,
                resolve: (field)=>field.description
            },
            args: {
                type: GraphQLNonNull(GraphQLList(GraphQLNonNull(__InputValue))),
                resolve: (field)=>field.args
            },
            type: {
                type: GraphQLNonNull(__Type),
                resolve: (field)=>field.type
            },
            isDeprecated: {
                type: GraphQLNonNull(GraphQLBoolean),
                resolve: (field)=>field.isDeprecated
            },
            deprecationReason: {
                type: GraphQLString,
                resolve: (field)=>field.deprecationReason
            }
        })
});
const __InputValue = new GraphQLObjectType({
    name: '__InputValue',
    description: 'Arguments provided to Fields or Directives and the input fields of an InputObject are represented as Input Values which describe their type and optionally a default value.',
    fields: ()=>({
            name: {
                type: GraphQLNonNull(GraphQLString),
                resolve: (inputValue)=>inputValue.name
            },
            description: {
                type: GraphQLString,
                resolve: (inputValue)=>inputValue.description
            },
            type: {
                type: GraphQLNonNull(__Type),
                resolve: (inputValue)=>inputValue.type
            },
            defaultValue: {
                type: GraphQLString,
                description: 'A GraphQL-formatted string representing the default value for this input value.',
                resolve (inputValue) {
                    const { type: type44 , defaultValue  } = inputValue;
                    const valueAST = astFromValue(defaultValue, type44);
                    return valueAST ? print(valueAST) : null;
                }
            }
        })
});
const __EnumValue = new GraphQLObjectType({
    name: '__EnumValue',
    description: 'One possible value for a given Enum. Enum values are unique values, not a placeholder for a string or numeric value. However an Enum value is returned in a JSON response as a string.',
    fields: ()=>({
            name: {
                type: GraphQLNonNull(GraphQLString),
                resolve: (enumValue)=>enumValue.name
            },
            description: {
                type: GraphQLString,
                resolve: (enumValue)=>enumValue.description
            },
            isDeprecated: {
                type: GraphQLNonNull(GraphQLBoolean),
                resolve: (enumValue)=>enumValue.isDeprecated
            },
            deprecationReason: {
                type: GraphQLString,
                resolve: (enumValue)=>enumValue.deprecationReason
            }
        })
});
const TypeKind = Object.freeze({
    SCALAR: 'SCALAR',
    OBJECT: 'OBJECT',
    INTERFACE: 'INTERFACE',
    UNION: 'UNION',
    ENUM: 'ENUM',
    INPUT_OBJECT: 'INPUT_OBJECT',
    LIST: 'LIST',
    NON_NULL: 'NON_NULL'
});
const __TypeKind = new GraphQLEnumType({
    name: '__TypeKind',
    description: 'An enum describing what kind of type a given `__Type` is.',
    values: {
        SCALAR: {
            value: TypeKind.SCALAR,
            description: 'Indicates this type is a scalar.'
        },
        OBJECT: {
            value: TypeKind.OBJECT,
            description: 'Indicates this type is an object. `fields` and `interfaces` are valid fields.'
        },
        INTERFACE: {
            value: TypeKind.INTERFACE,
            description: 'Indicates this type is an interface. `fields`, `interfaces`, and `possibleTypes` are valid fields.'
        },
        UNION: {
            value: TypeKind.UNION,
            description: 'Indicates this type is a union. `possibleTypes` is a valid field.'
        },
        ENUM: {
            value: TypeKind.ENUM,
            description: 'Indicates this type is an enum. `enumValues` is a valid field.'
        },
        INPUT_OBJECT: {
            value: TypeKind.INPUT_OBJECT,
            description: 'Indicates this type is an input object. `inputFields` is a valid field.'
        },
        LIST: {
            value: TypeKind.LIST,
            description: 'Indicates this type is a list. `ofType` is a valid field.'
        },
        NON_NULL: {
            value: TypeKind.NON_NULL,
            description: 'Indicates this type is a non-null. `ofType` is a valid field.'
        }
    }
});
const SchemaMetaFieldDef = {
    name: '__schema',
    type: GraphQLNonNull(__Schema),
    description: 'Access the current type schema of this server.',
    args: [],
    resolve: (_source, _args, _context, { schema  })=>schema
    ,
    isDeprecated: false,
    deprecationReason: undefined,
    extensions: undefined,
    astNode: undefined
};
const TypeMetaFieldDef = {
    name: '__type',
    type: __Type,
    description: 'Request the type information of a single type.',
    args: [
        {
            name: 'name',
            description: undefined,
            type: GraphQLNonNull(GraphQLString),
            defaultValue: undefined,
            extensions: undefined,
            astNode: undefined
        }
    ],
    resolve: (_source, { name  }, _context, { schema  })=>schema.getType(name)
    ,
    isDeprecated: false,
    deprecationReason: undefined,
    extensions: undefined,
    astNode: undefined
};
const TypeNameMetaFieldDef = {
    name: '__typename',
    type: GraphQLNonNull(GraphQLString),
    description: 'The name of the current Object type at runtime.',
    args: [],
    resolve: (_source, _args, _context, { parentType  })=>parentType.name
    ,
    isDeprecated: false,
    deprecationReason: undefined,
    extensions: undefined,
    astNode: undefined
};
const introspectionTypes = Object.freeze([
    __Schema,
    __Directive,
    __DirectiveLocation,
    __Type,
    __Field,
    __InputValue,
    __EnumValue,
    __TypeKind
]);
function isIntrospectionType(type45) {
    return introspectionTypes.some(({ name  })=>type45.name === name
    );
}
function isSchema(schema) {
    return __default(schema, GraphQLSchema);
}
function assertSchema(schema) {
    if (!isSchema(schema)) {
        throw new Error(`Expected ${inspect(schema)} to be a GraphQL schema.`);
    }
    return schema;
}
class GraphQLSchema {
    constructor(config){
        this.__validationErrors = config.assumeValid === true ? [] : undefined;
        devAssert(isObjectLike(config), 'Must provide configuration object.');
        devAssert(!config.types || Array.isArray(config.types), `"types" must be Array if provided but got: ${inspect(config.types)}.`);
        devAssert(!config.directives || Array.isArray(config.directives), '"directives" must be Array if provided but got: ' + `${inspect(config.directives)}.`);
        this.description = config.description;
        this.extensions = config.extensions && toObjMap(config.extensions);
        this.astNode = config.astNode;
        this.extensionASTNodes = config.extensionASTNodes;
        this._queryType = config.query;
        this._mutationType = config.mutation;
        this._subscriptionType = config.subscription;
        this._directives = config.directives ?? specifiedDirectives;
        const allReferencedTypes = new Set(config.types);
        if (config.types != null) {
            for (const type46 of config.types){
                allReferencedTypes.delete(type46);
                collectReferencedTypes(type46, allReferencedTypes);
            }
        }
        if (this._queryType != null) {
            collectReferencedTypes(this._queryType, allReferencedTypes);
        }
        if (this._mutationType != null) {
            collectReferencedTypes(this._mutationType, allReferencedTypes);
        }
        if (this._subscriptionType != null) {
            collectReferencedTypes(this._subscriptionType, allReferencedTypes);
        }
        for (const directive of this._directives){
            if (isDirective(directive)) {
                for (const arg of directive.args){
                    collectReferencedTypes(arg.type, allReferencedTypes);
                }
            }
        }
        collectReferencedTypes(__Schema, allReferencedTypes);
        this._typeMap = Object.create(null);
        this._subTypeMap = Object.create(null);
        this._implementationsMap = Object.create(null);
        for (const namedType of arrayFrom(allReferencedTypes)){
            if (namedType == null) {
                continue;
            }
            const typeName = namedType.name;
            devAssert(typeName, 'One of the provided types for building the Schema is missing a name.');
            if (this._typeMap[typeName] !== undefined) {
                throw new Error(`Schema must contain uniquely named types but contains multiple types named "${typeName}".`);
            }
            this._typeMap[typeName] = namedType;
            if (isInterfaceType(namedType)) {
                for (const iface of namedType.getInterfaces()){
                    if (isInterfaceType(iface)) {
                        let implementations = this._implementationsMap[iface.name];
                        if (implementations === undefined) {
                            implementations = this._implementationsMap[iface.name] = {
                                objects: [],
                                interfaces: []
                            };
                        }
                        implementations.interfaces.push(namedType);
                    }
                }
            } else if (isObjectType(namedType)) {
                for (const iface of namedType.getInterfaces()){
                    if (isInterfaceType(iface)) {
                        let implementations = this._implementationsMap[iface.name];
                        if (implementations === undefined) {
                            implementations = this._implementationsMap[iface.name] = {
                                objects: [],
                                interfaces: []
                            };
                        }
                        implementations.objects.push(namedType);
                    }
                }
            }
        }
    }
    getQueryType() {
        return this._queryType;
    }
    getMutationType() {
        return this._mutationType;
    }
    getSubscriptionType() {
        return this._subscriptionType;
    }
    getTypeMap() {
        return this._typeMap;
    }
    getType(name) {
        return this.getTypeMap()[name];
    }
    getPossibleTypes(abstractType) {
        return isUnionType(abstractType) ? abstractType.getTypes() : this.getImplementations(abstractType).objects;
    }
    getImplementations(interfaceType) {
        const implementations = this._implementationsMap[interfaceType.name];
        return implementations ?? {
            objects: [],
            interfaces: []
        };
    }
    isPossibleType(abstractType, possibleType) {
        return this.isSubType(abstractType, possibleType);
    }
    isSubType(abstractType, maybeSubType) {
        let map5 = this._subTypeMap[abstractType.name];
        if (map5 === undefined) {
            map5 = Object.create(null);
            if (isUnionType(abstractType)) {
                for (const type of abstractType.getTypes()){
                    map5[type.name] = true;
                }
            } else {
                const implementations = this.getImplementations(abstractType);
                for (const type of implementations.objects){
                    map5[type.name] = true;
                }
                for (const type1 of implementations.interfaces){
                    map5[type1.name] = true;
                }
            }
            this._subTypeMap[abstractType.name] = map5;
        }
        return map5[maybeSubType.name] !== undefined;
    }
    getDirectives() {
        return this._directives;
    }
    getDirective(name) {
        return find(this.getDirectives(), (directive)=>directive.name === name
        );
    }
    toConfig() {
        return {
            description: this.description,
            query: this.getQueryType(),
            mutation: this.getMutationType(),
            subscription: this.getSubscriptionType(),
            types: objectValues(this.getTypeMap()),
            directives: this.getDirectives().slice(),
            extensions: this.extensions,
            astNode: this.astNode,
            extensionASTNodes: this.extensionASTNodes ?? [],
            assumeValid: this.__validationErrors !== undefined
        };
    }
    get [SYMBOL_TO_STRING_TAG]() {
        return 'GraphQLSchema';
    }
}
function collectReferencedTypes(type47, typeSet) {
    const namedType = getNamedType(type47);
    if (!typeSet.has(namedType)) {
        typeSet.add(namedType);
        if (isUnionType(namedType)) {
            for (const memberType of namedType.getTypes()){
                collectReferencedTypes(memberType, typeSet);
            }
        } else if (isObjectType(namedType) || isInterfaceType(namedType)) {
            for (const interfaceType of namedType.getInterfaces()){
                collectReferencedTypes(interfaceType, typeSet);
            }
            for (const field of objectValues(namedType.getFields())){
                collectReferencedTypes(field.type, typeSet);
                for (const arg of field.args){
                    collectReferencedTypes(arg.type, typeSet);
                }
            }
        } else if (isInputObjectType(namedType)) {
            for (const field of objectValues(namedType.getFields())){
                collectReferencedTypes(field.type, typeSet);
            }
        }
    }
    return typeSet;
}
function validateSchema(schema) {
    assertSchema(schema);
    if (schema.__validationErrors) {
        return schema.__validationErrors;
    }
    const context = new SchemaValidationContext(schema);
    validateRootTypes(context);
    validateDirectives(context);
    validateTypes(context);
    const errors = context.getErrors();
    schema.__validationErrors = errors;
    return errors;
}
function assertValidSchema(schema) {
    const errors = validateSchema(schema);
    if (errors.length !== 0) {
        throw new Error(errors.map((error)=>error.message
        ).join('\n\n'));
    }
}
class SchemaValidationContext {
    constructor(schema){
        this._errors = [];
        this.schema = schema;
    }
    reportError(message, nodes) {
        const _nodes = Array.isArray(nodes) ? nodes.filter(Boolean) : nodes;
        this.addError(new GraphQLError(message, _nodes));
    }
    addError(error) {
        this._errors.push(error);
    }
    getErrors() {
        return this._errors;
    }
}
function validateRootTypes(context) {
    const schema = context.schema;
    const queryType = schema.getQueryType();
    if (!queryType) {
        context.reportError('Query root type must be provided.', schema.astNode);
    } else if (!isObjectType(queryType)) {
        context.reportError(`Query root type must be Object type, it cannot be ${inspect(queryType)}.`, getOperationTypeNode(schema, queryType, 'query'));
    }
    const mutationType = schema.getMutationType();
    if (mutationType && !isObjectType(mutationType)) {
        context.reportError('Mutation root type must be Object type if provided, it cannot be ' + `${inspect(mutationType)}.`, getOperationTypeNode(schema, mutationType, 'mutation'));
    }
    const subscriptionType = schema.getSubscriptionType();
    if (subscriptionType && !isObjectType(subscriptionType)) {
        context.reportError('Subscription root type must be Object type if provided, it cannot be ' + `${inspect(subscriptionType)}.`, getOperationTypeNode(schema, subscriptionType, 'subscription'));
    }
}
function getOperationTypeNode(schema, type48, operation) {
    const operationNodes = getAllSubNodes(schema, (node)=>node.operationTypes
    );
    for (const node1 of operationNodes){
        if (node1.operation === operation) {
            return node1.type;
        }
    }
    return type48.astNode;
}
function validateDirectives(context) {
    for (const directive of context.schema.getDirectives()){
        if (!isDirective(directive)) {
            context.reportError(`Expected directive but got: ${inspect(directive)}.`, directive?.astNode);
            continue;
        }
        validateName(context, directive);
        for (const arg of directive.args){
            validateName(context, arg);
            if (!isInputType(arg.type)) {
                context.reportError(`The type of @${directive.name}(${arg.name}:) must be Input Type ` + `but got: ${inspect(arg.type)}.`, arg.astNode);
            }
        }
    }
}
function validateName(context, node) {
    const error = isValidNameError(node.name);
    if (error) {
        context.addError(locatedError(error, node.astNode));
    }
}
function validateTypes(context) {
    const validateInputObjectCircularRefs = createInputObjectCircularRefsValidator(context);
    const typeMap = context.schema.getTypeMap();
    for (const type49 of objectValues(typeMap)){
        if (!isNamedType(type49)) {
            context.reportError(`Expected GraphQL named type but got: ${inspect(type49)}.`, type49.astNode);
            continue;
        }
        if (!isIntrospectionType(type49)) {
            validateName(context, type49);
        }
        if (isObjectType(type49)) {
            validateFields(context, type49);
            validateInterfaces(context, type49);
        } else if (isInterfaceType(type49)) {
            validateFields(context, type49);
            validateInterfaces(context, type49);
        } else if (isUnionType(type49)) {
            validateUnionMembers(context, type49);
        } else if (isEnumType(type49)) {
            validateEnumValues(context, type49);
        } else if (isInputObjectType(type49)) {
            validateInputFields(context, type49);
            validateInputObjectCircularRefs(type49);
        }
    }
}
function validateFields(context, type50) {
    const fields = objectValues(type50.getFields());
    if (fields.length === 0) {
        context.reportError(`Type ${type50.name} must define one or more fields.`, getAllNodes(type50));
    }
    for (const field of fields){
        validateName(context, field);
        if (!isOutputType(field.type)) {
            context.reportError(`The type of ${type50.name}.${field.name} must be Output Type ` + `but got: ${inspect(field.type)}.`, field.astNode?.type);
        }
        for (const arg of field.args){
            const argName = arg.name;
            validateName(context, arg);
            if (!isInputType(arg.type)) {
                context.reportError(`The type of ${type50.name}.${field.name}(${argName}:) must be Input ` + `Type but got: ${inspect(arg.type)}.`, arg.astNode?.type);
            }
        }
    }
}
function validateInterfaces(context, type51) {
    const ifaceTypeNames = Object.create(null);
    for (const iface of type51.getInterfaces()){
        if (!isInterfaceType(iface)) {
            context.reportError(`Type ${inspect(type51)} must only implement Interface types, ` + `it cannot implement ${inspect(iface)}.`, getAllImplementsInterfaceNodes(type51, iface));
            continue;
        }
        if (type51 === iface) {
            context.reportError(`Type ${type51.name} cannot implement itself because it would create a circular reference.`, getAllImplementsInterfaceNodes(type51, iface));
            continue;
        }
        if (ifaceTypeNames[iface.name]) {
            context.reportError(`Type ${type51.name} can only implement ${iface.name} once.`, getAllImplementsInterfaceNodes(type51, iface));
            continue;
        }
        ifaceTypeNames[iface.name] = true;
        validateTypeImplementsAncestors(context, type51, iface);
        validateTypeImplementsInterface(context, type51, iface);
    }
}
function validateTypeImplementsInterface(context, type52, iface) {
    const typeFieldMap = type52.getFields();
    for (const ifaceField of objectValues(iface.getFields())){
        const fieldName = ifaceField.name;
        const typeField = typeFieldMap[fieldName];
        if (!typeField) {
            context.reportError(`Interface field ${iface.name}.${fieldName} expected but ${type52.name} does not provide it.`, [
                ifaceField.astNode,
                ...getAllNodes(type52)
            ]);
            continue;
        }
        if (!isTypeSubTypeOf(context.schema, typeField.type, ifaceField.type)) {
            context.reportError(`Interface field ${iface.name}.${fieldName} expects type ` + `${inspect(ifaceField.type)} but ${type52.name}.${fieldName} ` + `is type ${inspect(typeField.type)}.`, [
                ifaceField.astNode.type,
                typeField.astNode.type
            ]);
        }
        for (const ifaceArg of ifaceField.args){
            const argName = ifaceArg.name;
            const typeArg = find(typeField.args, (arg)=>arg.name === argName
            );
            if (!typeArg) {
                context.reportError(`Interface field argument ${iface.name}.${fieldName}(${argName}:) expected but ${type52.name}.${fieldName} does not provide it.`, [
                    ifaceArg.astNode,
                    typeField.astNode
                ]);
                continue;
            }
            if (!isEqualType(ifaceArg.type, typeArg.type)) {
                context.reportError(`Interface field argument ${iface.name}.${fieldName}(${argName}:) ` + `expects type ${inspect(ifaceArg.type)} but ` + `${type52.name}.${fieldName}(${argName}:) is type ` + `${inspect(typeArg.type)}.`, [
                    ifaceArg.astNode.type,
                    typeArg.astNode.type
                ]);
            }
        }
        for (const typeArg of typeField.args){
            const argName = typeArg.name;
            const ifaceArg = find(ifaceField.args, (arg)=>arg.name === argName
            );
            if (!ifaceArg && isRequiredArgument(typeArg)) {
                context.reportError(`Object field ${type52.name}.${fieldName} includes required argument ${argName} that is missing from the Interface field ${iface.name}.${fieldName}.`, [
                    typeArg.astNode,
                    ifaceField.astNode
                ]);
            }
        }
    }
}
function validateTypeImplementsAncestors(context, type53, iface) {
    const ifaceInterfaces = type53.getInterfaces();
    for (const transitive of iface.getInterfaces()){
        if (ifaceInterfaces.indexOf(transitive) === -1) {
            context.reportError(transitive === type53 ? `Type ${type53.name} cannot implement ${iface.name} because it would create a circular reference.` : `Type ${type53.name} must implement ${transitive.name} because it is implemented by ${iface.name}.`, [
                ...getAllImplementsInterfaceNodes(iface, transitive),
                ...getAllImplementsInterfaceNodes(type53, iface)
            ]);
        }
    }
}
function validateUnionMembers(context, union1) {
    const memberTypes = union1.getTypes();
    if (memberTypes.length === 0) {
        context.reportError(`Union type ${union1.name} must define one or more member types.`, getAllNodes(union1));
    }
    const includedTypeNames = Object.create(null);
    for (const memberType of memberTypes){
        if (includedTypeNames[memberType.name]) {
            context.reportError(`Union type ${union1.name} can only include type ${memberType.name} once.`, getUnionMemberTypeNodes(union1, memberType.name));
            continue;
        }
        includedTypeNames[memberType.name] = true;
        if (!isObjectType(memberType)) {
            context.reportError(`Union type ${union1.name} can only include Object types, ` + `it cannot include ${inspect(memberType)}.`, getUnionMemberTypeNodes(union1, String(memberType)));
        }
    }
}
function validateEnumValues(context, enumType) {
    const enumValues = enumType.getValues();
    if (enumValues.length === 0) {
        context.reportError(`Enum type ${enumType.name} must define one or more values.`, getAllNodes(enumType));
    }
    for (const enumValue of enumValues){
        const valueName = enumValue.name;
        validateName(context, enumValue);
        if (valueName === 'true' || valueName === 'false' || valueName === 'null') {
            context.reportError(`Enum type ${enumType.name} cannot include value: ${valueName}.`, enumValue.astNode);
        }
    }
}
function validateInputFields(context, inputObj) {
    const fields = objectValues(inputObj.getFields());
    if (fields.length === 0) {
        context.reportError(`Input Object type ${inputObj.name} must define one or more fields.`, getAllNodes(inputObj));
    }
    for (const field of fields){
        validateName(context, field);
        if (!isInputType(field.type)) {
            context.reportError(`The type of ${inputObj.name}.${field.name} must be Input Type ` + `but got: ${inspect(field.type)}.`, field.astNode?.type);
        }
    }
}
function createInputObjectCircularRefsValidator(context) {
    const visitedTypes = Object.create(null);
    const fieldPath = [];
    const fieldPathIndexByTypeName = Object.create(null);
    return detectCycleRecursive;
    function detectCycleRecursive(inputObj) {
        if (visitedTypes[inputObj.name]) {
            return;
        }
        visitedTypes[inputObj.name] = true;
        fieldPathIndexByTypeName[inputObj.name] = fieldPath.length;
        const fields = objectValues(inputObj.getFields());
        for (const field of fields){
            if (isNonNullType(field.type) && isInputObjectType(field.type.ofType)) {
                const fieldType = field.type.ofType;
                const cycleIndex = fieldPathIndexByTypeName[fieldType.name];
                fieldPath.push(field);
                if (cycleIndex === undefined) {
                    detectCycleRecursive(fieldType);
                } else {
                    const cyclePath = fieldPath.slice(cycleIndex);
                    const pathStr = cyclePath.map((fieldObj)=>fieldObj.name
                    ).join('.');
                    context.reportError(`Cannot reference Input Object "${fieldType.name}" within itself through a series of non-null fields: "${pathStr}".`, cyclePath.map((fieldObj)=>fieldObj.astNode
                    ));
                }
                fieldPath.pop();
            }
        }
        fieldPathIndexByTypeName[inputObj.name] = undefined;
    }
}
function getAllNodes(object) {
    const { astNode , extensionASTNodes  } = object;
    return astNode ? extensionASTNodes ? [
        astNode
    ].concat(extensionASTNodes) : [
        astNode
    ] : extensionASTNodes ?? [];
}
function getAllSubNodes(object, getter) {
    return flatMap(getAllNodes(object), (item)=>getter(item) ?? []
    );
}
function getAllImplementsInterfaceNodes(type54, iface) {
    return getAllSubNodes(type54, (typeNode)=>typeNode.interfaces
    ).filter((ifaceNode)=>ifaceNode.name.value === iface.name
    );
}
function getUnionMemberTypeNodes(union2, typeName) {
    return getAllSubNodes(union2, (unionNode)=>unionNode.types
    ).filter((typeNode)=>typeNode.name.value === typeName
    );
}
function typeFromAST(schema, typeNode) {
    let innerType;
    if (typeNode.kind === Kind.LIST_TYPE) {
        innerType = typeFromAST(schema, typeNode.type);
        return innerType && GraphQLList(innerType);
    }
    if (typeNode.kind === Kind.NON_NULL_TYPE) {
        innerType = typeFromAST(schema, typeNode.type);
        return innerType && GraphQLNonNull(innerType);
    }
    if (typeNode.kind === Kind.NAMED_TYPE) {
        return schema.getType(typeNode.name.value);
    }
    invariant(false, 'Unexpected type node: ' + inspect(typeNode));
}
class TypeInfo {
    constructor(schema, getFieldDefFn, initialType){
        this._schema = schema;
        this._typeStack = [];
        this._parentTypeStack = [];
        this._inputTypeStack = [];
        this._fieldDefStack = [];
        this._defaultValueStack = [];
        this._directive = null;
        this._argument = null;
        this._enumValue = null;
        this._getFieldDef = getFieldDefFn ?? getFieldDef;
        if (initialType) {
            if (isInputType(initialType)) {
                this._inputTypeStack.push(initialType);
            }
            if (isCompositeType(initialType)) {
                this._parentTypeStack.push(initialType);
            }
            if (isOutputType(initialType)) {
                this._typeStack.push(initialType);
            }
        }
    }
    getType() {
        if (this._typeStack.length > 0) {
            return this._typeStack[this._typeStack.length - 1];
        }
    }
    getParentType() {
        if (this._parentTypeStack.length > 0) {
            return this._parentTypeStack[this._parentTypeStack.length - 1];
        }
    }
    getInputType() {
        if (this._inputTypeStack.length > 0) {
            return this._inputTypeStack[this._inputTypeStack.length - 1];
        }
    }
    getParentInputType() {
        if (this._inputTypeStack.length > 1) {
            return this._inputTypeStack[this._inputTypeStack.length - 2];
        }
    }
    getFieldDef() {
        if (this._fieldDefStack.length > 0) {
            return this._fieldDefStack[this._fieldDefStack.length - 1];
        }
    }
    getDefaultValue() {
        if (this._defaultValueStack.length > 0) {
            return this._defaultValueStack[this._defaultValueStack.length - 1];
        }
    }
    getDirective() {
        return this._directive;
    }
    getArgument() {
        return this._argument;
    }
    getEnumValue() {
        return this._enumValue;
    }
    enter(node) {
        const schema = this._schema;
        switch(node.kind){
            case Kind.SELECTION_SET:
                {
                    const namedType = getNamedType(this.getType());
                    this._parentTypeStack.push(isCompositeType(namedType) ? namedType : undefined);
                    break;
                }
            case Kind.FIELD:
                {
                    const parentType = this.getParentType();
                    let fieldDef;
                    let fieldType;
                    if (parentType) {
                        fieldDef = this._getFieldDef(schema, parentType, node);
                        if (fieldDef) {
                            fieldType = fieldDef.type;
                        }
                    }
                    this._fieldDefStack.push(fieldDef);
                    this._typeStack.push(isOutputType(fieldType) ? fieldType : undefined);
                    break;
                }
            case Kind.DIRECTIVE:
                this._directive = schema.getDirective(node.name.value);
                break;
            case Kind.OPERATION_DEFINITION:
                {
                    let type55;
                    switch(node.operation){
                        case 'query':
                            type55 = schema.getQueryType();
                            break;
                        case 'mutation':
                            type55 = schema.getMutationType();
                            break;
                        case 'subscription':
                            type55 = schema.getSubscriptionType();
                            break;
                    }
                    this._typeStack.push(isObjectType(type55) ? type55 : undefined);
                    break;
                }
            case Kind.INLINE_FRAGMENT:
            case Kind.FRAGMENT_DEFINITION:
                {
                    const typeConditionAST = node.typeCondition;
                    const outputType = typeConditionAST ? typeFromAST(schema, typeConditionAST) : getNamedType(this.getType());
                    this._typeStack.push(isOutputType(outputType) ? outputType : undefined);
                    break;
                }
            case Kind.VARIABLE_DEFINITION:
                {
                    const inputType = typeFromAST(schema, node.type);
                    this._inputTypeStack.push(isInputType(inputType) ? inputType : undefined);
                    break;
                }
            case Kind.ARGUMENT:
                {
                    let argDef;
                    let argType;
                    const fieldOrDirective = this.getDirective() ?? this.getFieldDef();
                    if (fieldOrDirective) {
                        argDef = find(fieldOrDirective.args, (arg)=>arg.name === node.name.value
                        );
                        if (argDef) {
                            argType = argDef.type;
                        }
                    }
                    this._argument = argDef;
                    this._defaultValueStack.push(argDef ? argDef.defaultValue : undefined);
                    this._inputTypeStack.push(isInputType(argType) ? argType : undefined);
                    break;
                }
            case Kind.LIST:
                {
                    const listType = getNullableType(this.getInputType());
                    const itemType = isListType(listType) ? listType.ofType : listType;
                    this._defaultValueStack.push(undefined);
                    this._inputTypeStack.push(isInputType(itemType) ? itemType : undefined);
                    break;
                }
            case Kind.OBJECT_FIELD:
                {
                    const objectType = getNamedType(this.getInputType());
                    let inputFieldType;
                    let inputField;
                    if (isInputObjectType(objectType)) {
                        inputField = objectType.getFields()[node.name.value];
                        if (inputField) {
                            inputFieldType = inputField.type;
                        }
                    }
                    this._defaultValueStack.push(inputField ? inputField.defaultValue : undefined);
                    this._inputTypeStack.push(isInputType(inputFieldType) ? inputFieldType : undefined);
                    break;
                }
            case Kind.ENUM:
                {
                    const enumType = getNamedType(this.getInputType());
                    let enumValue;
                    if (isEnumType(enumType)) {
                        enumValue = enumType.getValue(node.value);
                    }
                    this._enumValue = enumValue;
                    break;
                }
        }
    }
    leave(node) {
        switch(node.kind){
            case Kind.SELECTION_SET:
                this._parentTypeStack.pop();
                break;
            case Kind.FIELD:
                this._fieldDefStack.pop();
                this._typeStack.pop();
                break;
            case Kind.DIRECTIVE:
                this._directive = null;
                break;
            case Kind.OPERATION_DEFINITION:
            case Kind.INLINE_FRAGMENT:
            case Kind.FRAGMENT_DEFINITION:
                this._typeStack.pop();
                break;
            case Kind.VARIABLE_DEFINITION:
                this._inputTypeStack.pop();
                break;
            case Kind.ARGUMENT:
                this._argument = null;
                this._defaultValueStack.pop();
                this._inputTypeStack.pop();
                break;
            case Kind.LIST:
            case Kind.OBJECT_FIELD:
                this._defaultValueStack.pop();
                this._inputTypeStack.pop();
                break;
            case Kind.ENUM:
                this._enumValue = null;
                break;
        }
    }
}
function getFieldDef(schema, parentType, fieldNode) {
    const name = fieldNode.name.value;
    if (name === SchemaMetaFieldDef.name && schema.getQueryType() === parentType) {
        return SchemaMetaFieldDef;
    }
    if (name === TypeMetaFieldDef.name && schema.getQueryType() === parentType) {
        return TypeMetaFieldDef;
    }
    if (name === TypeNameMetaFieldDef.name && isCompositeType(parentType)) {
        return TypeNameMetaFieldDef;
    }
    if (isObjectType(parentType) || isInterfaceType(parentType)) {
        return parentType.getFields()[name];
    }
}
function visitWithTypeInfo(typeInfo, visitor) {
    return {
        enter (node) {
            typeInfo.enter(node);
            const fn = getVisitFn(visitor, node.kind, false);
            if (fn) {
                const result = fn.apply(visitor, arguments);
                if (result !== undefined) {
                    typeInfo.leave(node);
                    if (isNode(result)) {
                        typeInfo.enter(result);
                    }
                }
                return result;
            }
        },
        leave (node) {
            const fn = getVisitFn(visitor, node.kind, true);
            let result;
            if (fn) {
                result = fn.apply(visitor, arguments);
            }
            typeInfo.leave(node);
            return result;
        }
    };
}
function isExecutableDefinitionNode(node) {
    return node.kind === Kind.OPERATION_DEFINITION || node.kind === Kind.FRAGMENT_DEFINITION;
}
function isTypeSystemDefinitionNode(node) {
    return node.kind === Kind.SCHEMA_DEFINITION || isTypeDefinitionNode(node) || node.kind === Kind.DIRECTIVE_DEFINITION;
}
function isTypeDefinitionNode(node) {
    return node.kind === Kind.SCALAR_TYPE_DEFINITION || node.kind === Kind.OBJECT_TYPE_DEFINITION || node.kind === Kind.INTERFACE_TYPE_DEFINITION || node.kind === Kind.UNION_TYPE_DEFINITION || node.kind === Kind.ENUM_TYPE_DEFINITION || node.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION;
}
function isTypeSystemExtensionNode(node) {
    return node.kind === Kind.SCHEMA_EXTENSION || isTypeExtensionNode(node);
}
function isTypeExtensionNode(node) {
    return node.kind === Kind.SCALAR_TYPE_EXTENSION || node.kind === Kind.OBJECT_TYPE_EXTENSION || node.kind === Kind.INTERFACE_TYPE_EXTENSION || node.kind === Kind.UNION_TYPE_EXTENSION || node.kind === Kind.ENUM_TYPE_EXTENSION || node.kind === Kind.INPUT_OBJECT_TYPE_EXTENSION;
}
function ExecutableDefinitionsRule(context) {
    return {
        Document (node) {
            for (const definition of node.definitions){
                if (!isExecutableDefinitionNode(definition)) {
                    const defName = definition.kind === Kind.SCHEMA_DEFINITION || definition.kind === Kind.SCHEMA_EXTENSION ? 'schema' : '"' + definition.name.value + '"';
                    context.reportError(new GraphQLError(`The ${defName} definition is not executable.`, definition));
                }
            }
            return false;
        }
    };
}
function UniqueOperationNamesRule(context) {
    const knownOperationNames = Object.create(null);
    return {
        OperationDefinition (node) {
            const operationName = node.name;
            if (operationName) {
                if (knownOperationNames[operationName.value]) {
                    context.reportError(new GraphQLError(`There can be only one operation named "${operationName.value}".`, [
                        knownOperationNames[operationName.value],
                        operationName
                    ]));
                } else {
                    knownOperationNames[operationName.value] = operationName;
                }
            }
            return false;
        },
        FragmentDefinition: ()=>false
    };
}
function LoneAnonymousOperationRule(context) {
    let operationCount = 0;
    return {
        Document (node) {
            operationCount = node.definitions.filter((definition)=>definition.kind === Kind.OPERATION_DEFINITION
            ).length;
        },
        OperationDefinition (node) {
            if (!node.name && operationCount > 1) {
                context.reportError(new GraphQLError('This anonymous operation must be the only defined operation.', node));
            }
        }
    };
}
function SingleFieldSubscriptionsRule(context) {
    return {
        OperationDefinition (node) {
            if (node.operation === 'subscription') {
                if (node.selectionSet.selections.length !== 1) {
                    context.reportError(new GraphQLError(node.name ? `Subscription "${node.name.value}" must select only one top level field.` : 'Anonymous Subscription must select only one top level field.', node.selectionSet.selections.slice(1)));
                }
            }
        }
    };
}
function KnownTypeNamesRule(context) {
    const schema = context.getSchema();
    const existingTypesMap = schema ? schema.getTypeMap() : Object.create(null);
    const definedTypes = Object.create(null);
    for (const def of context.getDocument().definitions){
        if (isTypeDefinitionNode(def)) {
            definedTypes[def.name.value] = true;
        }
    }
    const typeNames = Object.keys(existingTypesMap).concat(Object.keys(definedTypes));
    return {
        NamedType (node, _1, parent, _2, ancestors) {
            const typeName = node.name.value;
            if (!existingTypesMap[typeName] && !definedTypes[typeName]) {
                const definitionNode = ancestors[2] ?? parent;
                const isSDL = definitionNode != null && isSDLNode(definitionNode);
                if (isSDL && isSpecifiedScalarName(typeName)) {
                    return;
                }
                const suggestedTypes = suggestionList(typeName, isSDL ? specifiedScalarsNames.concat(typeNames) : typeNames);
                context.reportError(new GraphQLError(`Unknown type "${typeName}".` + didYouMean(suggestedTypes), node));
            }
        }
    };
}
const specifiedScalarsNames = specifiedScalarTypes.map((type56)=>type56.name
);
function isSpecifiedScalarName(typeName) {
    return specifiedScalarsNames.indexOf(typeName) !== -1;
}
function isSDLNode(value) {
    return !Array.isArray(value) && (isTypeSystemDefinitionNode(value) || isTypeSystemExtensionNode(value));
}
function FragmentsOnCompositeTypesRule(context) {
    return {
        InlineFragment (node) {
            const typeCondition = node.typeCondition;
            if (typeCondition) {
                const type57 = typeFromAST(context.getSchema(), typeCondition);
                if (type57 && !isCompositeType(type57)) {
                    const typeStr = print(typeCondition);
                    context.reportError(new GraphQLError(`Fragment cannot condition on non composite type "${typeStr}".`, typeCondition));
                }
            }
        },
        FragmentDefinition (node) {
            const type58 = typeFromAST(context.getSchema(), node.typeCondition);
            if (type58 && !isCompositeType(type58)) {
                const typeStr = print(node.typeCondition);
                context.reportError(new GraphQLError(`Fragment "${node.name.value}" cannot condition on non composite type "${typeStr}".`, node.typeCondition));
            }
        }
    };
}
function VariablesAreInputTypesRule(context) {
    return {
        VariableDefinition (node) {
            const type59 = typeFromAST(context.getSchema(), node.type);
            if (type59 && !isInputType(type59)) {
                const variableName = node.variable.name.value;
                const typeName = print(node.type);
                context.reportError(new GraphQLError(`Variable "$${variableName}" cannot be non-input type "${typeName}".`, node.type));
            }
        }
    };
}
function ScalarLeafsRule(context) {
    return {
        Field (node) {
            const type60 = context.getType();
            const selectionSet = node.selectionSet;
            if (type60) {
                if (isLeafType(getNamedType(type60))) {
                    if (selectionSet) {
                        const fieldName = node.name.value;
                        const typeStr = inspect(type60);
                        context.reportError(new GraphQLError(`Field "${fieldName}" must not have a selection since type "${typeStr}" has no subfields.`, selectionSet));
                    }
                } else if (!selectionSet) {
                    const fieldName = node.name.value;
                    const typeStr = inspect(type60);
                    context.reportError(new GraphQLError(`Field "${fieldName}" of type "${typeStr}" must have a selection of subfields. Did you mean "${fieldName} { ... }"?`, node));
                }
            }
        }
    };
}
function FieldsOnCorrectTypeRule(context) {
    return {
        Field (node) {
            const type61 = context.getParentType();
            if (type61) {
                const fieldDef = context.getFieldDef();
                if (!fieldDef) {
                    const schema = context.getSchema();
                    const fieldName = node.name.value;
                    let suggestion = didYouMean('to use an inline fragment on', getSuggestedTypeNames(schema, type61, fieldName));
                    if (suggestion === '') {
                        suggestion = didYouMean(getSuggestedFieldNames(type61, fieldName));
                    }
                    context.reportError(new GraphQLError(`Cannot query field "${fieldName}" on type "${type61.name}".` + suggestion, node));
                }
            }
        }
    };
}
function getSuggestedTypeNames(schema, type62, fieldName) {
    if (!isAbstractType(type62)) {
        return [];
    }
    const suggestedTypes = new Set();
    const usageCount = Object.create(null);
    for (const possibleType of schema.getPossibleTypes(type62)){
        if (!possibleType.getFields()[fieldName]) {
            continue;
        }
        suggestedTypes.add(possibleType);
        usageCount[possibleType.name] = 1;
        for (const possibleInterface of possibleType.getInterfaces()){
            if (!possibleInterface.getFields()[fieldName]) {
                continue;
            }
            suggestedTypes.add(possibleInterface);
            usageCount[possibleInterface.name] = (usageCount[possibleInterface.name] ?? 0) + 1;
        }
    }
    return arrayFrom(suggestedTypes).sort((typeA, typeB)=>{
        const usageCountDiff = usageCount[typeB.name] - usageCount[typeA.name];
        if (usageCountDiff !== 0) {
            return usageCountDiff;
        }
        if (isInterfaceType(typeA) && schema.isSubType(typeA, typeB)) {
            return -1;
        }
        if (isInterfaceType(typeB) && schema.isSubType(typeB, typeA)) {
            return 1;
        }
        return typeA.name.localeCompare(typeB.name);
    }).map((x)=>x.name
    );
}
function getSuggestedFieldNames(type63, fieldName) {
    if (isObjectType(type63) || isInterfaceType(type63)) {
        const possibleFieldNames = Object.keys(type63.getFields());
        return suggestionList(fieldName, possibleFieldNames);
    }
    return [];
}
function UniqueFragmentNamesRule(context) {
    const knownFragmentNames = Object.create(null);
    return {
        OperationDefinition: ()=>false
        ,
        FragmentDefinition (node) {
            const fragmentName = node.name.value;
            if (knownFragmentNames[fragmentName]) {
                context.reportError(new GraphQLError(`There can be only one fragment named "${fragmentName}".`, [
                    knownFragmentNames[fragmentName],
                    node.name
                ]));
            } else {
                knownFragmentNames[fragmentName] = node.name;
            }
            return false;
        }
    };
}
function KnownFragmentNamesRule(context) {
    return {
        FragmentSpread (node) {
            const fragmentName = node.name.value;
            const fragment = context.getFragment(fragmentName);
            if (!fragment) {
                context.reportError(new GraphQLError(`Unknown fragment "${fragmentName}".`, node.name));
            }
        }
    };
}
function NoUnusedFragmentsRule(context) {
    const operationDefs = [];
    const fragmentDefs = [];
    return {
        OperationDefinition (node) {
            operationDefs.push(node);
            return false;
        },
        FragmentDefinition (node) {
            fragmentDefs.push(node);
            return false;
        },
        Document: {
            leave () {
                const fragmentNameUsed = Object.create(null);
                for (const operation of operationDefs){
                    for (const fragment of context.getRecursivelyReferencedFragments(operation)){
                        fragmentNameUsed[fragment.name.value] = true;
                    }
                }
                for (const fragmentDef of fragmentDefs){
                    const fragName = fragmentDef.name.value;
                    if (fragmentNameUsed[fragName] !== true) {
                        context.reportError(new GraphQLError(`Fragment "${fragName}" is never used.`, fragmentDef));
                    }
                }
            }
        }
    };
}
function PossibleFragmentSpreadsRule(context) {
    return {
        InlineFragment (node) {
            const fragType = context.getType();
            const parentType = context.getParentType();
            if (isCompositeType(fragType) && isCompositeType(parentType) && !doTypesOverlap(context.getSchema(), fragType, parentType)) {
                const parentTypeStr = inspect(parentType);
                const fragTypeStr = inspect(fragType);
                context.reportError(new GraphQLError(`Fragment cannot be spread here as objects of type "${parentTypeStr}" can never be of type "${fragTypeStr}".`, node));
            }
        },
        FragmentSpread (node) {
            const fragName = node.name.value;
            const fragType = getFragmentType(context, fragName);
            const parentType = context.getParentType();
            if (fragType && parentType && !doTypesOverlap(context.getSchema(), fragType, parentType)) {
                const parentTypeStr = inspect(parentType);
                const fragTypeStr = inspect(fragType);
                context.reportError(new GraphQLError(`Fragment "${fragName}" cannot be spread here as objects of type "${parentTypeStr}" can never be of type "${fragTypeStr}".`, node));
            }
        }
    };
}
function getFragmentType(context, name) {
    const frag = context.getFragment(name);
    if (frag) {
        const type64 = typeFromAST(context.getSchema(), frag.typeCondition);
        if (isCompositeType(type64)) {
            return type64;
        }
    }
}
function NoFragmentCyclesRule(context) {
    const visitedFrags = Object.create(null);
    const spreadPath = [];
    const spreadPathIndexByName = Object.create(null);
    return {
        OperationDefinition: ()=>false
        ,
        FragmentDefinition (node) {
            detectCycleRecursive(node);
            return false;
        }
    };
    function detectCycleRecursive(fragment) {
        if (visitedFrags[fragment.name.value]) {
            return;
        }
        const fragmentName = fragment.name.value;
        visitedFrags[fragmentName] = true;
        const spreadNodes = context.getFragmentSpreads(fragment.selectionSet);
        if (spreadNodes.length === 0) {
            return;
        }
        spreadPathIndexByName[fragmentName] = spreadPath.length;
        for (const spreadNode of spreadNodes){
            const spreadName = spreadNode.name.value;
            const cycleIndex = spreadPathIndexByName[spreadName];
            spreadPath.push(spreadNode);
            if (cycleIndex === undefined) {
                const spreadFragment = context.getFragment(spreadName);
                if (spreadFragment) {
                    detectCycleRecursive(spreadFragment);
                }
            } else {
                const cyclePath = spreadPath.slice(cycleIndex);
                const viaPath = cyclePath.slice(0, -1).map((s)=>'"' + s.name.value + '"'
                ).join(', ');
                context.reportError(new GraphQLError(`Cannot spread fragment "${spreadName}" within itself` + (viaPath !== '' ? ` via ${viaPath}.` : '.'), cyclePath));
            }
            spreadPath.pop();
        }
        spreadPathIndexByName[fragmentName] = undefined;
    }
}
function UniqueVariableNamesRule(context) {
    let knownVariableNames = Object.create(null);
    return {
        OperationDefinition () {
            knownVariableNames = Object.create(null);
        },
        VariableDefinition (node) {
            const variableName = node.variable.name.value;
            if (knownVariableNames[variableName]) {
                context.reportError(new GraphQLError(`There can be only one variable named "$${variableName}".`, [
                    knownVariableNames[variableName],
                    node.variable.name
                ]));
            } else {
                knownVariableNames[variableName] = node.variable.name;
            }
        }
    };
}
function NoUndefinedVariablesRule(context) {
    let variableNameDefined = Object.create(null);
    return {
        OperationDefinition: {
            enter () {
                variableNameDefined = Object.create(null);
            },
            leave (operation) {
                const usages = context.getRecursiveVariableUsages(operation);
                for (const { node  } of usages){
                    const varName = node.name.value;
                    if (variableNameDefined[varName] !== true) {
                        context.reportError(new GraphQLError(operation.name ? `Variable "$${varName}" is not defined by operation "${operation.name.value}".` : `Variable "$${varName}" is not defined.`, [
                            node,
                            operation
                        ]));
                    }
                }
            }
        },
        VariableDefinition (node) {
            variableNameDefined[node.variable.name.value] = true;
        }
    };
}
function NoUnusedVariablesRule(context) {
    let variableDefs = [];
    return {
        OperationDefinition: {
            enter () {
                variableDefs = [];
            },
            leave (operation) {
                const variableNameUsed = Object.create(null);
                const usages = context.getRecursiveVariableUsages(operation);
                for (const { node  } of usages){
                    variableNameUsed[node.name.value] = true;
                }
                for (const variableDef of variableDefs){
                    const variableName = variableDef.variable.name.value;
                    if (variableNameUsed[variableName] !== true) {
                        context.reportError(new GraphQLError(operation.name ? `Variable "$${variableName}" is never used in operation "${operation.name.value}".` : `Variable "$${variableName}" is never used.`, variableDef));
                    }
                }
            }
        },
        VariableDefinition (def) {
            variableDefs.push(def);
        }
    };
}
function KnownDirectivesRule(context) {
    const locationsMap = Object.create(null);
    const schema = context.getSchema();
    const definedDirectives = schema ? schema.getDirectives() : specifiedDirectives;
    for (const directive of definedDirectives){
        locationsMap[directive.name] = directive.locations;
    }
    const astDefinitions = context.getDocument().definitions;
    for (const def of astDefinitions){
        if (def.kind === Kind.DIRECTIVE_DEFINITION) {
            locationsMap[def.name.value] = def.locations.map((name)=>name.value
            );
        }
    }
    return {
        Directive (node, _key, _parent, _path, ancestors) {
            const name = node.name.value;
            const locations = locationsMap[name];
            if (!locations) {
                context.reportError(new GraphQLError(`Unknown directive "@${name}".`, node));
                return;
            }
            const candidateLocation = getDirectiveLocationForASTPath(ancestors);
            if (candidateLocation && locations.indexOf(candidateLocation) === -1) {
                context.reportError(new GraphQLError(`Directive "@${name}" may not be used on ${candidateLocation}.`, node));
            }
        }
    };
}
function getDirectiveLocationForASTPath(ancestors) {
    const appliedTo = ancestors[ancestors.length - 1];
    invariant(!Array.isArray(appliedTo));
    switch(appliedTo.kind){
        case Kind.OPERATION_DEFINITION:
            return getDirectiveLocationForOperation(appliedTo.operation);
        case Kind.FIELD:
            return DirectiveLocation.FIELD;
        case Kind.FRAGMENT_SPREAD:
            return DirectiveLocation.FRAGMENT_SPREAD;
        case Kind.INLINE_FRAGMENT:
            return DirectiveLocation.INLINE_FRAGMENT;
        case Kind.FRAGMENT_DEFINITION:
            return DirectiveLocation.FRAGMENT_DEFINITION;
        case Kind.VARIABLE_DEFINITION:
            return DirectiveLocation.VARIABLE_DEFINITION;
        case Kind.SCHEMA_DEFINITION:
        case Kind.SCHEMA_EXTENSION:
            return DirectiveLocation.SCHEMA;
        case Kind.SCALAR_TYPE_DEFINITION:
        case Kind.SCALAR_TYPE_EXTENSION:
            return DirectiveLocation.SCALAR;
        case Kind.OBJECT_TYPE_DEFINITION:
        case Kind.OBJECT_TYPE_EXTENSION:
            return DirectiveLocation.OBJECT;
        case Kind.FIELD_DEFINITION:
            return DirectiveLocation.FIELD_DEFINITION;
        case Kind.INTERFACE_TYPE_DEFINITION:
        case Kind.INTERFACE_TYPE_EXTENSION:
            return DirectiveLocation.INTERFACE;
        case Kind.UNION_TYPE_DEFINITION:
        case Kind.UNION_TYPE_EXTENSION:
            return DirectiveLocation.UNION;
        case Kind.ENUM_TYPE_DEFINITION:
        case Kind.ENUM_TYPE_EXTENSION:
            return DirectiveLocation.ENUM;
        case Kind.ENUM_VALUE_DEFINITION:
            return DirectiveLocation.ENUM_VALUE;
        case Kind.INPUT_OBJECT_TYPE_DEFINITION:
        case Kind.INPUT_OBJECT_TYPE_EXTENSION:
            return DirectiveLocation.INPUT_OBJECT;
        case Kind.INPUT_VALUE_DEFINITION:
            {
                const parentNode = ancestors[ancestors.length - 3];
                return parentNode.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION ? DirectiveLocation.INPUT_FIELD_DEFINITION : DirectiveLocation.ARGUMENT_DEFINITION;
            }
    }
}
function getDirectiveLocationForOperation(operation) {
    switch(operation){
        case 'query':
            return DirectiveLocation.QUERY;
        case 'mutation':
            return DirectiveLocation.MUTATION;
        case 'subscription':
            return DirectiveLocation.SUBSCRIPTION;
    }
    invariant(false, 'Unexpected operation: ' + inspect(operation));
}
function UniqueDirectivesPerLocationRule(context) {
    const uniqueDirectiveMap = Object.create(null);
    const schema = context.getSchema();
    const definedDirectives = schema ? schema.getDirectives() : specifiedDirectives;
    for (const directive1 of definedDirectives){
        uniqueDirectiveMap[directive1.name] = !directive1.isRepeatable;
    }
    const astDefinitions = context.getDocument().definitions;
    for (const def of astDefinitions){
        if (def.kind === Kind.DIRECTIVE_DEFINITION) {
            uniqueDirectiveMap[def.name.value] = !def.repeatable;
        }
    }
    const schemaDirectives = Object.create(null);
    const typeDirectivesMap = Object.create(null);
    return {
        enter (node) {
            if (node.directives == null) {
                return;
            }
            let seenDirectives;
            if (node.kind === Kind.SCHEMA_DEFINITION || node.kind === Kind.SCHEMA_EXTENSION) {
                seenDirectives = schemaDirectives;
            } else if (isTypeDefinitionNode(node) || isTypeExtensionNode(node)) {
                const typeName = node.name.value;
                seenDirectives = typeDirectivesMap[typeName];
                if (seenDirectives === undefined) {
                    typeDirectivesMap[typeName] = seenDirectives = Object.create(null);
                }
            } else {
                seenDirectives = Object.create(null);
            }
            for (const directive of node.directives){
                const directiveName = directive.name.value;
                if (uniqueDirectiveMap[directiveName]) {
                    if (seenDirectives[directiveName]) {
                        context.reportError(new GraphQLError(`The directive "@${directiveName}" can only be used once at this location.`, [
                            seenDirectives[directiveName],
                            directive
                        ]));
                    } else {
                        seenDirectives[directiveName] = directive;
                    }
                }
            }
        }
    };
}
function KnownArgumentNamesRule(context) {
    return {
        ...KnownArgumentNamesOnDirectivesRule(context),
        Argument (argNode) {
            const argDef = context.getArgument();
            const fieldDef = context.getFieldDef();
            const parentType = context.getParentType();
            if (!argDef && fieldDef && parentType) {
                const argName = argNode.name.value;
                const knownArgsNames = fieldDef.args.map((arg)=>arg.name
                );
                const suggestions = suggestionList(argName, knownArgsNames);
                context.reportError(new GraphQLError(`Unknown argument "${argName}" on field "${parentType.name}.${fieldDef.name}".` + didYouMean(suggestions), argNode));
            }
        }
    };
}
function KnownArgumentNamesOnDirectivesRule(context) {
    const directiveArgs = Object.create(null);
    const schema = context.getSchema();
    const definedDirectives = schema ? schema.getDirectives() : specifiedDirectives;
    for (const directive of definedDirectives){
        directiveArgs[directive.name] = directive.args.map((arg)=>arg.name
        );
    }
    const astDefinitions = context.getDocument().definitions;
    for (const def of astDefinitions){
        if (def.kind === Kind.DIRECTIVE_DEFINITION) {
            const argsNodes = def.arguments ?? [];
            directiveArgs[def.name.value] = argsNodes.map((arg)=>arg.name.value
            );
        }
    }
    return {
        Directive (directiveNode) {
            const directiveName = directiveNode.name.value;
            const knownArgs = directiveArgs[directiveName];
            if (directiveNode.arguments && knownArgs) {
                for (const argNode of directiveNode.arguments){
                    const argName = argNode.name.value;
                    if (knownArgs.indexOf(argName) === -1) {
                        const suggestions = suggestionList(argName, knownArgs);
                        context.reportError(new GraphQLError(`Unknown argument "${argName}" on directive "@${directiveName}".` + didYouMean(suggestions), argNode));
                    }
                }
            }
            return false;
        }
    };
}
function UniqueArgumentNamesRule(context) {
    let knownArgNames = Object.create(null);
    return {
        Field () {
            knownArgNames = Object.create(null);
        },
        Directive () {
            knownArgNames = Object.create(null);
        },
        Argument (node) {
            const argName = node.name.value;
            if (knownArgNames[argName]) {
                context.reportError(new GraphQLError(`There can be only one argument named "${argName}".`, [
                    knownArgNames[argName],
                    node.name
                ]));
            } else {
                knownArgNames[argName] = node.name;
            }
            return false;
        }
    };
}
function ValuesOfCorrectTypeRule(context) {
    return {
        ListValue (node) {
            const type65 = getNullableType(context.getParentInputType());
            if (!isListType(type65)) {
                isValidValueNode(context, node);
                return false;
            }
        },
        ObjectValue (node) {
            const type66 = getNamedType(context.getInputType());
            if (!isInputObjectType(type66)) {
                isValidValueNode(context, node);
                return false;
            }
            const fieldNodeMap = keyMap(node.fields, (field)=>field.name.value
            );
            for (const fieldDef of objectValues(type66.getFields())){
                const fieldNode = fieldNodeMap[fieldDef.name];
                if (!fieldNode && isRequiredInputField(fieldDef)) {
                    const typeStr = inspect(fieldDef.type);
                    context.reportError(new GraphQLError(`Field "${type66.name}.${fieldDef.name}" of required type "${typeStr}" was not provided.`, node));
                }
            }
        },
        ObjectField (node) {
            const parentType = getNamedType(context.getParentInputType());
            const fieldType = context.getInputType();
            if (!fieldType && isInputObjectType(parentType)) {
                const suggestions = suggestionList(node.name.value, Object.keys(parentType.getFields()));
                context.reportError(new GraphQLError(`Field "${node.name.value}" is not defined by type "${parentType.name}".` + didYouMean(suggestions), node));
            }
        },
        NullValue (node) {
            const type67 = context.getInputType();
            if (isNonNullType(type67)) {
                context.reportError(new GraphQLError(`Expected value of type "${inspect(type67)}", found ${print(node)}.`, node));
            }
        },
        EnumValue: (node)=>isValidValueNode(context, node)
        ,
        IntValue: (node)=>isValidValueNode(context, node)
        ,
        FloatValue: (node)=>isValidValueNode(context, node)
        ,
        StringValue: (node)=>isValidValueNode(context, node)
        ,
        BooleanValue: (node)=>isValidValueNode(context, node)
    };
}
function isValidValueNode(context, node) {
    const locationType = context.getInputType();
    if (!locationType) {
        return;
    }
    const type68 = getNamedType(locationType);
    if (!isLeafType(type68)) {
        const typeStr = inspect(locationType);
        context.reportError(new GraphQLError(`Expected value of type "${typeStr}", found ${print(node)}.`, node));
        return;
    }
    try {
        const parseResult = type68.parseLiteral(node, undefined);
        if (parseResult === undefined) {
            const typeStr = inspect(locationType);
            context.reportError(new GraphQLError(`Expected value of type "${typeStr}", found ${print(node)}.`, node));
        }
    } catch (error) {
        const typeStr = inspect(locationType);
        if (error instanceof GraphQLError) {
            context.reportError(error);
        } else {
            context.reportError(new GraphQLError(`Expected value of type "${typeStr}", found ${print(node)}; ` + error.message, node, undefined, undefined, undefined, error));
        }
    }
}
function ProvidedRequiredArgumentsRule(context) {
    return {
        ...ProvidedRequiredArgumentsOnDirectivesRule(context),
        Field: {
            leave (fieldNode) {
                const fieldDef = context.getFieldDef();
                if (!fieldDef) {
                    return false;
                }
                const argNodes = fieldNode.arguments ?? [];
                const argNodeMap = keyMap(argNodes, (arg)=>arg.name.value
                );
                for (const argDef of fieldDef.args){
                    const argNode = argNodeMap[argDef.name];
                    if (!argNode && isRequiredArgument(argDef)) {
                        const argTypeStr = inspect(argDef.type);
                        context.reportError(new GraphQLError(`Field "${fieldDef.name}" argument "${argDef.name}" of type "${argTypeStr}" is required, but it was not provided.`, fieldNode));
                    }
                }
            }
        }
    };
}
function ProvidedRequiredArgumentsOnDirectivesRule(context) {
    const requiredArgsMap = Object.create(null);
    const schema = context.getSchema();
    const definedDirectives = schema ? schema.getDirectives() : specifiedDirectives;
    for (const directive of definedDirectives){
        requiredArgsMap[directive.name] = keyMap(directive.args.filter(isRequiredArgument), (arg)=>arg.name
        );
    }
    const astDefinitions = context.getDocument().definitions;
    for (const def of astDefinitions){
        if (def.kind === Kind.DIRECTIVE_DEFINITION) {
            const argNodes = def.arguments ?? [];
            requiredArgsMap[def.name.value] = keyMap(argNodes.filter(isRequiredArgumentNode), (arg)=>arg.name.value
            );
        }
    }
    return {
        Directive: {
            leave (directiveNode) {
                const directiveName = directiveNode.name.value;
                const requiredArgs = requiredArgsMap[directiveName];
                if (requiredArgs) {
                    const argNodes = directiveNode.arguments ?? [];
                    const argNodeMap = keyMap(argNodes, (arg)=>arg.name.value
                    );
                    for (const argName of Object.keys(requiredArgs)){
                        if (!argNodeMap[argName]) {
                            const argType = requiredArgs[argName].type;
                            const argTypeStr = isType(argType) ? inspect(argType) : print(argType);
                            context.reportError(new GraphQLError(`Directive "@${directiveName}" argument "${argName}" of type "${argTypeStr}" is required, but it was not provided.`, directiveNode));
                        }
                    }
                }
            }
        }
    };
}
function isRequiredArgumentNode(arg) {
    return arg.type.kind === Kind.NON_NULL_TYPE && arg.defaultValue == null;
}
function VariablesInAllowedPositionRule(context) {
    let varDefMap = Object.create(null);
    return {
        OperationDefinition: {
            enter () {
                varDefMap = Object.create(null);
            },
            leave (operation) {
                const usages = context.getRecursiveVariableUsages(operation);
                for (const { node , type: type69 , defaultValue  } of usages){
                    const varName = node.name.value;
                    const varDef = varDefMap[varName];
                    if (varDef && type69) {
                        const schema = context.getSchema();
                        const varType = typeFromAST(schema, varDef.type);
                        if (varType && !allowedVariableUsage(schema, varType, varDef.defaultValue, type69, defaultValue)) {
                            const varTypeStr = inspect(varType);
                            const typeStr = inspect(type69);
                            context.reportError(new GraphQLError(`Variable "$${varName}" of type "${varTypeStr}" used in position expecting type "${typeStr}".`, [
                                varDef,
                                node
                            ]));
                        }
                    }
                }
            }
        },
        VariableDefinition (node) {
            varDefMap[node.variable.name.value] = node;
        }
    };
}
function allowedVariableUsage(schema, varType, varDefaultValue, locationType, locationDefaultValue) {
    if (isNonNullType(locationType) && !isNonNullType(varType)) {
        const hasNonNullVariableDefaultValue = varDefaultValue != null && varDefaultValue.kind !== Kind.NULL;
        const hasLocationDefaultValue = locationDefaultValue !== undefined;
        if (!hasNonNullVariableDefaultValue && !hasLocationDefaultValue) {
            return false;
        }
        const nullableLocationType = locationType.ofType;
        return isTypeSubTypeOf(schema, varType, nullableLocationType);
    }
    return isTypeSubTypeOf(schema, varType, locationType);
}
function reasonMessage(reason) {
    if (Array.isArray(reason)) {
        return reason.map(([responseName, subReason])=>`subfields "${responseName}" conflict because ` + reasonMessage(subReason)
        ).join(' and ');
    }
    return reason;
}
function OverlappingFieldsCanBeMergedRule(context) {
    const comparedFragmentPairs = new PairSet();
    const cachedFieldsAndFragmentNames = new Map();
    return {
        SelectionSet (selectionSet) {
            const conflicts = findConflictsWithinSelectionSet(context, cachedFieldsAndFragmentNames, comparedFragmentPairs, context.getParentType(), selectionSet);
            for (const [[responseName, reason], fields1, fields2] of conflicts){
                const reasonMsg = reasonMessage(reason);
                context.reportError(new GraphQLError(`Fields "${responseName}" conflict because ${reasonMsg}. Use different aliases on the fields to fetch both if this was intentional.`, fields1.concat(fields2)));
            }
        }
    };
}
function findConflictsWithinSelectionSet(context, cachedFieldsAndFragmentNames, comparedFragmentPairs, parentType, selectionSet) {
    const conflicts = [];
    const [fieldMap, fragmentNames] = getFieldsAndFragmentNames(context, cachedFieldsAndFragmentNames, parentType, selectionSet);
    collectConflictsWithin(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, fieldMap);
    if (fragmentNames.length !== 0) {
        for(let i14 = 0; i14 < fragmentNames.length; i14++){
            collectConflictsBetweenFieldsAndFragment(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, false, fieldMap, fragmentNames[i14]);
            for(let j = i14 + 1; j < fragmentNames.length; j++){
                collectConflictsBetweenFragments(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, false, fragmentNames[i14], fragmentNames[j]);
            }
        }
    }
    return conflicts;
}
function collectConflictsBetweenFieldsAndFragment(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, areMutuallyExclusive, fieldMap, fragmentName) {
    const fragment = context.getFragment(fragmentName);
    if (!fragment) {
        return;
    }
    const [fieldMap2, fragmentNames2] = getReferencedFieldsAndFragmentNames(context, cachedFieldsAndFragmentNames, fragment);
    if (fieldMap === fieldMap2) {
        return;
    }
    collectConflictsBetween(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, areMutuallyExclusive, fieldMap, fieldMap2);
    for(let i15 = 0; i15 < fragmentNames2.length; i15++){
        collectConflictsBetweenFieldsAndFragment(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, areMutuallyExclusive, fieldMap, fragmentNames2[i15]);
    }
}
function collectConflictsBetweenFragments(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, areMutuallyExclusive, fragmentName1, fragmentName2) {
    if (fragmentName1 === fragmentName2) {
        return;
    }
    if (comparedFragmentPairs.has(fragmentName1, fragmentName2, areMutuallyExclusive)) {
        return;
    }
    comparedFragmentPairs.add(fragmentName1, fragmentName2, areMutuallyExclusive);
    const fragment1 = context.getFragment(fragmentName1);
    const fragment2 = context.getFragment(fragmentName2);
    if (!fragment1 || !fragment2) {
        return;
    }
    const [fieldMap1, fragmentNames1] = getReferencedFieldsAndFragmentNames(context, cachedFieldsAndFragmentNames, fragment1);
    const [fieldMap2, fragmentNames2] = getReferencedFieldsAndFragmentNames(context, cachedFieldsAndFragmentNames, fragment2);
    collectConflictsBetween(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, areMutuallyExclusive, fieldMap1, fieldMap2);
    for(let j = 0; j < fragmentNames2.length; j++){
        collectConflictsBetweenFragments(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, areMutuallyExclusive, fragmentName1, fragmentNames2[j]);
    }
    for(let i16 = 0; i16 < fragmentNames1.length; i16++){
        collectConflictsBetweenFragments(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, areMutuallyExclusive, fragmentNames1[i16], fragmentName2);
    }
}
function findConflictsBetweenSubSelectionSets(context, cachedFieldsAndFragmentNames, comparedFragmentPairs, areMutuallyExclusive, parentType1, selectionSet1, parentType2, selectionSet2) {
    const conflicts = [];
    const [fieldMap1, fragmentNames1] = getFieldsAndFragmentNames(context, cachedFieldsAndFragmentNames, parentType1, selectionSet1);
    const [fieldMap2, fragmentNames2] = getFieldsAndFragmentNames(context, cachedFieldsAndFragmentNames, parentType2, selectionSet2);
    collectConflictsBetween(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, areMutuallyExclusive, fieldMap1, fieldMap2);
    if (fragmentNames2.length !== 0) {
        for(let j = 0; j < fragmentNames2.length; j++){
            collectConflictsBetweenFieldsAndFragment(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, areMutuallyExclusive, fieldMap1, fragmentNames2[j]);
        }
    }
    if (fragmentNames1.length !== 0) {
        for(let i17 = 0; i17 < fragmentNames1.length; i17++){
            collectConflictsBetweenFieldsAndFragment(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, areMutuallyExclusive, fieldMap2, fragmentNames1[i17]);
        }
    }
    for(let i18 = 0; i18 < fragmentNames1.length; i18++){
        for(let j = 0; j < fragmentNames2.length; j++){
            collectConflictsBetweenFragments(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, areMutuallyExclusive, fragmentNames1[i18], fragmentNames2[j]);
        }
    }
    return conflicts;
}
function collectConflictsWithin(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, fieldMap) {
    for (const [responseName, fields] of objectEntries(fieldMap)){
        if (fields.length > 1) {
            for(let i19 = 0; i19 < fields.length; i19++){
                for(let j = i19 + 1; j < fields.length; j++){
                    const conflict = findConflict(context, cachedFieldsAndFragmentNames, comparedFragmentPairs, false, responseName, fields[i19], fields[j]);
                    if (conflict) {
                        conflicts.push(conflict);
                    }
                }
            }
        }
    }
}
function collectConflictsBetween(context, conflicts, cachedFieldsAndFragmentNames, comparedFragmentPairs, parentFieldsAreMutuallyExclusive, fieldMap1, fieldMap2) {
    for (const responseName of Object.keys(fieldMap1)){
        const fields2 = fieldMap2[responseName];
        if (fields2) {
            const fields1 = fieldMap1[responseName];
            for(let i20 = 0; i20 < fields1.length; i20++){
                for(let j = 0; j < fields2.length; j++){
                    const conflict = findConflict(context, cachedFieldsAndFragmentNames, comparedFragmentPairs, parentFieldsAreMutuallyExclusive, responseName, fields1[i20], fields2[j]);
                    if (conflict) {
                        conflicts.push(conflict);
                    }
                }
            }
        }
    }
}
function findConflict(context, cachedFieldsAndFragmentNames, comparedFragmentPairs, parentFieldsAreMutuallyExclusive, responseName, field1, field2) {
    const [parentType1, node1, def1] = field1;
    const [parentType2, node2, def2] = field2;
    const areMutuallyExclusive = parentFieldsAreMutuallyExclusive || parentType1 !== parentType2 && isObjectType(parentType1) && isObjectType(parentType2);
    if (!areMutuallyExclusive) {
        const name1 = node1.name.value;
        const name2 = node2.name.value;
        if (name1 !== name2) {
            return [
                [
                    responseName,
                    `"${name1}" and "${name2}" are different fields`
                ],
                [
                    node1
                ],
                [
                    node2
                ]
            ];
        }
        const args1 = node1.arguments ?? [];
        const args2 = node2.arguments ?? [];
        if (!sameArguments(args1, args2)) {
            return [
                [
                    responseName,
                    'they have differing arguments'
                ],
                [
                    node1
                ],
                [
                    node2
                ]
            ];
        }
    }
    const type1 = def1?.type;
    const type2 = def2?.type;
    if (type1 && type2 && doTypesConflict(type1, type2)) {
        return [
            [
                responseName,
                `they return conflicting types "${inspect(type1)}" and "${inspect(type2)}"`
            ],
            [
                node1
            ],
            [
                node2
            ]
        ];
    }
    const selectionSet1 = node1.selectionSet;
    const selectionSet2 = node2.selectionSet;
    if (selectionSet1 && selectionSet2) {
        const conflicts = findConflictsBetweenSubSelectionSets(context, cachedFieldsAndFragmentNames, comparedFragmentPairs, areMutuallyExclusive, getNamedType(type1), selectionSet1, getNamedType(type2), selectionSet2);
        return subfieldConflicts(conflicts, responseName, node1, node2);
    }
}
function sameArguments(arguments1, arguments2) {
    if (arguments1.length !== arguments2.length) {
        return false;
    }
    return arguments1.every((argument1)=>{
        const argument2 = find(arguments2, (argument)=>argument.name.value === argument1.name.value
        );
        if (!argument2) {
            return false;
        }
        return sameValue(argument1.value, argument2.value);
    });
}
function sameValue(value1, value2) {
    return print(value1) === print(value2);
}
function doTypesConflict(type1, type2) {
    if (isListType(type1)) {
        return isListType(type2) ? doTypesConflict(type1.ofType, type2.ofType) : true;
    }
    if (isListType(type2)) {
        return true;
    }
    if (isNonNullType(type1)) {
        return isNonNullType(type2) ? doTypesConflict(type1.ofType, type2.ofType) : true;
    }
    if (isNonNullType(type2)) {
        return true;
    }
    if (isLeafType(type1) || isLeafType(type2)) {
        return type1 !== type2;
    }
    return false;
}
function getFieldsAndFragmentNames(context, cachedFieldsAndFragmentNames, parentType, selectionSet) {
    let cached = cachedFieldsAndFragmentNames.get(selectionSet);
    if (!cached) {
        const nodeAndDefs = Object.create(null);
        const fragmentNames = Object.create(null);
        _collectFieldsAndFragmentNames(context, parentType, selectionSet, nodeAndDefs, fragmentNames);
        cached = [
            nodeAndDefs,
            Object.keys(fragmentNames)
        ];
        cachedFieldsAndFragmentNames.set(selectionSet, cached);
    }
    return cached;
}
function getReferencedFieldsAndFragmentNames(context, cachedFieldsAndFragmentNames, fragment) {
    const cached = cachedFieldsAndFragmentNames.get(fragment.selectionSet);
    if (cached) {
        return cached;
    }
    const fragmentType = typeFromAST(context.getSchema(), fragment.typeCondition);
    return getFieldsAndFragmentNames(context, cachedFieldsAndFragmentNames, fragmentType, fragment.selectionSet);
}
function _collectFieldsAndFragmentNames(context, parentType, selectionSet, nodeAndDefs, fragmentNames) {
    for (const selection of selectionSet.selections){
        switch(selection.kind){
            case Kind.FIELD:
                {
                    const fieldName = selection.name.value;
                    let fieldDef;
                    if (isObjectType(parentType) || isInterfaceType(parentType)) {
                        fieldDef = parentType.getFields()[fieldName];
                    }
                    const responseName = selection.alias ? selection.alias.value : fieldName;
                    if (!nodeAndDefs[responseName]) {
                        nodeAndDefs[responseName] = [];
                    }
                    nodeAndDefs[responseName].push([
                        parentType,
                        selection,
                        fieldDef
                    ]);
                    break;
                }
            case Kind.FRAGMENT_SPREAD:
                fragmentNames[selection.name.value] = true;
                break;
            case Kind.INLINE_FRAGMENT:
                {
                    const typeCondition = selection.typeCondition;
                    const inlineFragmentType = typeCondition ? typeFromAST(context.getSchema(), typeCondition) : parentType;
                    _collectFieldsAndFragmentNames(context, inlineFragmentType, selection.selectionSet, nodeAndDefs, fragmentNames);
                    break;
                }
        }
    }
}
function subfieldConflicts(conflicts, responseName, node1, node2) {
    if (conflicts.length > 0) {
        return [
            [
                responseName,
                conflicts.map(([reason])=>reason
                )
            ],
            conflicts.reduce((allFields, [, fields1])=>allFields.concat(fields1)
            , [
                node1
            ]),
            conflicts.reduce((allFields, [, , fields2])=>allFields.concat(fields2)
            , [
                node2
            ])
        ];
    }
}
class PairSet {
    constructor(){
        this._data = Object.create(null);
    }
    has(a, b, areMutuallyExclusive) {
        const first = this._data[a];
        const result = first && first[b];
        if (result === undefined) {
            return false;
        }
        if (areMutuallyExclusive === false) {
            return result === false;
        }
        return true;
    }
    add(a, b, areMutuallyExclusive) {
        _pairSetAdd(this._data, a, b, areMutuallyExclusive);
        _pairSetAdd(this._data, b, a, areMutuallyExclusive);
    }
}
function _pairSetAdd(data, a, b, areMutuallyExclusive) {
    let map6 = data[a];
    if (!map6) {
        map6 = Object.create(null);
        data[a] = map6;
    }
    map6[b] = areMutuallyExclusive;
}
function UniqueInputFieldNamesRule(context) {
    const knownNameStack = [];
    let knownNames = Object.create(null);
    return {
        ObjectValue: {
            enter () {
                knownNameStack.push(knownNames);
                knownNames = Object.create(null);
            },
            leave () {
                knownNames = knownNameStack.pop();
            }
        },
        ObjectField (node) {
            const fieldName = node.name.value;
            if (knownNames[fieldName]) {
                context.reportError(new GraphQLError(`There can be only one input field named "${fieldName}".`, [
                    knownNames[fieldName],
                    node.name
                ]));
            } else {
                knownNames[fieldName] = node.name;
            }
        }
    };
}
function LoneSchemaDefinitionRule(context) {
    const oldSchema = context.getSchema();
    const alreadyDefined = ((oldSchema?.astNode ?? oldSchema?.getQueryType()) ?? oldSchema?.getMutationType()) ?? oldSchema?.getSubscriptionType();
    let schemaDefinitionsCount = 0;
    return {
        SchemaDefinition (node) {
            if (alreadyDefined) {
                context.reportError(new GraphQLError('Cannot define a new schema within a schema extension.', node));
                return;
            }
            if (schemaDefinitionsCount > 0) {
                context.reportError(new GraphQLError('Must provide only one schema definition.', node));
            }
            ++schemaDefinitionsCount;
        }
    };
}
function UniqueOperationTypesRule(context) {
    const schema = context.getSchema();
    const definedOperationTypes = Object.create(null);
    const existingOperationTypes = schema ? {
        query: schema.getQueryType(),
        mutation: schema.getMutationType(),
        subscription: schema.getSubscriptionType()
    } : {};
    return {
        SchemaDefinition: checkOperationTypes,
        SchemaExtension: checkOperationTypes
    };
    function checkOperationTypes(node) {
        const operationTypesNodes = node.operationTypes ?? [];
        for (const operationType of operationTypesNodes){
            const operation = operationType.operation;
            const alreadyDefinedOperationType = definedOperationTypes[operation];
            if (existingOperationTypes[operation]) {
                context.reportError(new GraphQLError(`Type for ${operation} already defined in the schema. It cannot be redefined.`, operationType));
            } else if (alreadyDefinedOperationType) {
                context.reportError(new GraphQLError(`There can be only one ${operation} type in schema.`, [
                    alreadyDefinedOperationType,
                    operationType
                ]));
            } else {
                definedOperationTypes[operation] = operationType;
            }
        }
        return false;
    }
}
function UniqueTypeNamesRule(context) {
    const knownTypeNames = Object.create(null);
    const schema = context.getSchema();
    return {
        ScalarTypeDefinition: checkTypeName,
        ObjectTypeDefinition: checkTypeName,
        InterfaceTypeDefinition: checkTypeName,
        UnionTypeDefinition: checkTypeName,
        EnumTypeDefinition: checkTypeName,
        InputObjectTypeDefinition: checkTypeName
    };
    function checkTypeName(node) {
        const typeName = node.name.value;
        if (schema?.getType(typeName)) {
            context.reportError(new GraphQLError(`Type "${typeName}" already exists in the schema. It cannot also be defined in this type definition.`, node.name));
            return;
        }
        if (knownTypeNames[typeName]) {
            context.reportError(new GraphQLError(`There can be only one type named "${typeName}".`, [
                knownTypeNames[typeName],
                node.name
            ]));
        } else {
            knownTypeNames[typeName] = node.name;
        }
        return false;
    }
}
function UniqueEnumValueNamesRule(context) {
    const schema = context.getSchema();
    const existingTypeMap = schema ? schema.getTypeMap() : Object.create(null);
    const knownValueNames = Object.create(null);
    return {
        EnumTypeDefinition: checkValueUniqueness,
        EnumTypeExtension: checkValueUniqueness
    };
    function checkValueUniqueness(node) {
        const typeName = node.name.value;
        if (!knownValueNames[typeName]) {
            knownValueNames[typeName] = Object.create(null);
        }
        const valueNodes = node.values ?? [];
        const valueNames = knownValueNames[typeName];
        for (const valueDef of valueNodes){
            const valueName = valueDef.name.value;
            const existingType = existingTypeMap[typeName];
            if (isEnumType(existingType) && existingType.getValue(valueName)) {
                context.reportError(new GraphQLError(`Enum value "${typeName}.${valueName}" already exists in the schema. It cannot also be defined in this type extension.`, valueDef.name));
            } else if (valueNames[valueName]) {
                context.reportError(new GraphQLError(`Enum value "${typeName}.${valueName}" can only be defined once.`, [
                    valueNames[valueName],
                    valueDef.name
                ]));
            } else {
                valueNames[valueName] = valueDef.name;
            }
        }
        return false;
    }
}
function UniqueFieldDefinitionNamesRule(context) {
    const schema = context.getSchema();
    const existingTypeMap = schema ? schema.getTypeMap() : Object.create(null);
    const knownFieldNames = Object.create(null);
    return {
        InputObjectTypeDefinition: checkFieldUniqueness,
        InputObjectTypeExtension: checkFieldUniqueness,
        InterfaceTypeDefinition: checkFieldUniqueness,
        InterfaceTypeExtension: checkFieldUniqueness,
        ObjectTypeDefinition: checkFieldUniqueness,
        ObjectTypeExtension: checkFieldUniqueness
    };
    function checkFieldUniqueness(node) {
        const typeName = node.name.value;
        if (!knownFieldNames[typeName]) {
            knownFieldNames[typeName] = Object.create(null);
        }
        const fieldNodes = node.fields ?? [];
        const fieldNames = knownFieldNames[typeName];
        for (const fieldDef of fieldNodes){
            const fieldName = fieldDef.name.value;
            if (hasField(existingTypeMap[typeName], fieldName)) {
                context.reportError(new GraphQLError(`Field "${typeName}.${fieldName}" already exists in the schema. It cannot also be defined in this type extension.`, fieldDef.name));
            } else if (fieldNames[fieldName]) {
                context.reportError(new GraphQLError(`Field "${typeName}.${fieldName}" can only be defined once.`, [
                    fieldNames[fieldName],
                    fieldDef.name
                ]));
            } else {
                fieldNames[fieldName] = fieldDef.name;
            }
        }
        return false;
    }
}
function hasField(type70, fieldName) {
    if (isObjectType(type70) || isInterfaceType(type70) || isInputObjectType(type70)) {
        return type70.getFields()[fieldName];
    }
    return false;
}
function UniqueDirectiveNamesRule(context) {
    const knownDirectiveNames = Object.create(null);
    const schema = context.getSchema();
    return {
        DirectiveDefinition (node) {
            const directiveName = node.name.value;
            if (schema?.getDirective(directiveName)) {
                context.reportError(new GraphQLError(`Directive "@${directiveName}" already exists in the schema. It cannot be redefined.`, node.name));
                return;
            }
            if (knownDirectiveNames[directiveName]) {
                context.reportError(new GraphQLError(`There can be only one directive named "@${directiveName}".`, [
                    knownDirectiveNames[directiveName],
                    node.name
                ]));
            } else {
                knownDirectiveNames[directiveName] = node.name;
            }
            return false;
        }
    };
}
function PossibleTypeExtensionsRule(context) {
    const schema = context.getSchema();
    const definedTypes = Object.create(null);
    for (const def of context.getDocument().definitions){
        if (isTypeDefinitionNode(def)) {
            definedTypes[def.name.value] = def;
        }
    }
    return {
        ScalarTypeExtension: checkExtension,
        ObjectTypeExtension: checkExtension,
        InterfaceTypeExtension: checkExtension,
        UnionTypeExtension: checkExtension,
        EnumTypeExtension: checkExtension,
        InputObjectTypeExtension: checkExtension
    };
    function checkExtension(node) {
        const typeName = node.name.value;
        const defNode = definedTypes[typeName];
        const existingType = schema?.getType(typeName);
        let expectedKind;
        if (defNode) {
            expectedKind = defKindToExtKind[defNode.kind];
        } else if (existingType) {
            expectedKind = typeToExtKind(existingType);
        }
        if (expectedKind) {
            if (expectedKind !== node.kind) {
                const kindStr = extensionKindToTypeName(node.kind);
                context.reportError(new GraphQLError(`Cannot extend non-${kindStr} type "${typeName}".`, defNode ? [
                    defNode,
                    node
                ] : node));
            }
        } else {
            let allTypeNames = Object.keys(definedTypes);
            if (schema) {
                allTypeNames = allTypeNames.concat(Object.keys(schema.getTypeMap()));
            }
            const suggestedTypes = suggestionList(typeName, allTypeNames);
            context.reportError(new GraphQLError(`Cannot extend type "${typeName}" because it is not defined.` + didYouMean(suggestedTypes), node.name));
        }
    }
}
const defKindToExtKind = {
    [Kind.SCALAR_TYPE_DEFINITION]: Kind.SCALAR_TYPE_EXTENSION,
    [Kind.OBJECT_TYPE_DEFINITION]: Kind.OBJECT_TYPE_EXTENSION,
    [Kind.INTERFACE_TYPE_DEFINITION]: Kind.INTERFACE_TYPE_EXTENSION,
    [Kind.UNION_TYPE_DEFINITION]: Kind.UNION_TYPE_EXTENSION,
    [Kind.ENUM_TYPE_DEFINITION]: Kind.ENUM_TYPE_EXTENSION,
    [Kind.INPUT_OBJECT_TYPE_DEFINITION]: Kind.INPUT_OBJECT_TYPE_EXTENSION
};
function typeToExtKind(type71) {
    if (isScalarType(type71)) {
        return Kind.SCALAR_TYPE_EXTENSION;
    }
    if (isObjectType(type71)) {
        return Kind.OBJECT_TYPE_EXTENSION;
    }
    if (isInterfaceType(type71)) {
        return Kind.INTERFACE_TYPE_EXTENSION;
    }
    if (isUnionType(type71)) {
        return Kind.UNION_TYPE_EXTENSION;
    }
    if (isEnumType(type71)) {
        return Kind.ENUM_TYPE_EXTENSION;
    }
    if (isInputObjectType(type71)) {
        return Kind.INPUT_OBJECT_TYPE_EXTENSION;
    }
    invariant(false, 'Unexpected type: ' + inspect(type71));
}
function extensionKindToTypeName(kind) {
    switch(kind){
        case Kind.SCALAR_TYPE_EXTENSION:
            return 'scalar';
        case Kind.OBJECT_TYPE_EXTENSION:
            return 'object';
        case Kind.INTERFACE_TYPE_EXTENSION:
            return 'interface';
        case Kind.UNION_TYPE_EXTENSION:
            return 'union';
        case Kind.ENUM_TYPE_EXTENSION:
            return 'enum';
        case Kind.INPUT_OBJECT_TYPE_EXTENSION:
            return 'input object';
    }
    invariant(false, 'Unexpected kind: ' + inspect(kind));
}
const specifiedRules = Object.freeze([
    ExecutableDefinitionsRule,
    UniqueOperationNamesRule,
    LoneAnonymousOperationRule,
    SingleFieldSubscriptionsRule,
    KnownTypeNamesRule,
    FragmentsOnCompositeTypesRule,
    VariablesAreInputTypesRule,
    ScalarLeafsRule,
    FieldsOnCorrectTypeRule,
    UniqueFragmentNamesRule,
    KnownFragmentNamesRule,
    NoUnusedFragmentsRule,
    PossibleFragmentSpreadsRule,
    NoFragmentCyclesRule,
    UniqueVariableNamesRule,
    NoUndefinedVariablesRule,
    NoUnusedVariablesRule,
    KnownDirectivesRule,
    UniqueDirectivesPerLocationRule,
    KnownArgumentNamesRule,
    UniqueArgumentNamesRule,
    ValuesOfCorrectTypeRule,
    ProvidedRequiredArgumentsRule,
    VariablesInAllowedPositionRule,
    OverlappingFieldsCanBeMergedRule,
    UniqueInputFieldNamesRule
]);
const specifiedSDLRules = Object.freeze([
    LoneSchemaDefinitionRule,
    UniqueOperationTypesRule,
    UniqueTypeNamesRule,
    UniqueEnumValueNamesRule,
    UniqueFieldDefinitionNamesRule,
    UniqueDirectiveNamesRule,
    KnownTypeNamesRule,
    KnownDirectivesRule,
    UniqueDirectivesPerLocationRule,
    PossibleTypeExtensionsRule,
    KnownArgumentNamesOnDirectivesRule,
    UniqueArgumentNamesRule,
    UniqueInputFieldNamesRule,
    ProvidedRequiredArgumentsOnDirectivesRule
]);
class ASTValidationContext {
    constructor(ast, onError){
        this._ast = ast;
        this._fragments = undefined;
        this._fragmentSpreads = new Map();
        this._recursivelyReferencedFragments = new Map();
        this._onError = onError;
    }
    reportError(error) {
        this._onError(error);
    }
    getDocument() {
        return this._ast;
    }
    getFragment(name) {
        let fragments = this._fragments;
        if (!fragments) {
            this._fragments = fragments = this.getDocument().definitions.reduce((frags, statement)=>{
                if (statement.kind === Kind.FRAGMENT_DEFINITION) {
                    frags[statement.name.value] = statement;
                }
                return frags;
            }, Object.create(null));
        }
        return fragments[name];
    }
    getFragmentSpreads(node) {
        let spreads = this._fragmentSpreads.get(node);
        if (!spreads) {
            spreads = [];
            const setsToVisit = [
                node
            ];
            while(setsToVisit.length !== 0){
                const set3 = setsToVisit.pop();
                for (const selection of set3.selections){
                    if (selection.kind === Kind.FRAGMENT_SPREAD) {
                        spreads.push(selection);
                    } else if (selection.selectionSet) {
                        setsToVisit.push(selection.selectionSet);
                    }
                }
            }
            this._fragmentSpreads.set(node, spreads);
        }
        return spreads;
    }
    getRecursivelyReferencedFragments(operation) {
        let fragments = this._recursivelyReferencedFragments.get(operation);
        if (!fragments) {
            fragments = [];
            const collectedNames = Object.create(null);
            const nodesToVisit = [
                operation.selectionSet
            ];
            while(nodesToVisit.length !== 0){
                const node = nodesToVisit.pop();
                for (const spread of this.getFragmentSpreads(node)){
                    const fragName = spread.name.value;
                    if (collectedNames[fragName] !== true) {
                        collectedNames[fragName] = true;
                        const fragment = this.getFragment(fragName);
                        if (fragment) {
                            fragments.push(fragment);
                            nodesToVisit.push(fragment.selectionSet);
                        }
                    }
                }
            }
            this._recursivelyReferencedFragments.set(operation, fragments);
        }
        return fragments;
    }
}
class SDLValidationContext extends ASTValidationContext {
    constructor(ast, schema, onError){
        super(ast, onError);
        this._schema = schema;
    }
    getSchema() {
        return this._schema;
    }
}
class ValidationContext extends ASTValidationContext {
    constructor(schema, ast, typeInfo, onError){
        super(ast, onError);
        this._schema = schema;
        this._typeInfo = typeInfo;
        this._variableUsages = new Map();
        this._recursiveVariableUsages = new Map();
    }
    getSchema() {
        return this._schema;
    }
    getVariableUsages(node) {
        let usages = this._variableUsages.get(node);
        if (!usages) {
            const newUsages = [];
            const typeInfo = new TypeInfo(this._schema);
            visit(node, visitWithTypeInfo(typeInfo, {
                VariableDefinition: ()=>false
                ,
                Variable (variable) {
                    newUsages.push({
                        node: variable,
                        type: typeInfo.getInputType(),
                        defaultValue: typeInfo.getDefaultValue()
                    });
                }
            }));
            usages = newUsages;
            this._variableUsages.set(node, usages);
        }
        return usages;
    }
    getRecursiveVariableUsages(operation) {
        let usages = this._recursiveVariableUsages.get(operation);
        if (!usages) {
            usages = this.getVariableUsages(operation);
            for (const frag of this.getRecursivelyReferencedFragments(operation)){
                usages = usages.concat(this.getVariableUsages(frag));
            }
            this._recursiveVariableUsages.set(operation, usages);
        }
        return usages;
    }
    getType() {
        return this._typeInfo.getType();
    }
    getParentType() {
        return this._typeInfo.getParentType();
    }
    getInputType() {
        return this._typeInfo.getInputType();
    }
    getParentInputType() {
        return this._typeInfo.getParentInputType();
    }
    getFieldDef() {
        return this._typeInfo.getFieldDef();
    }
    getDirective() {
        return this._typeInfo.getDirective();
    }
    getArgument() {
        return this._typeInfo.getArgument();
    }
}
function validate(schema, documentAST, rules = specifiedRules, typeInfo = new TypeInfo(schema), options = {
    maxErrors: undefined
}) {
    devAssert(documentAST, 'Must provide document.');
    assertValidSchema(schema);
    const abortObj = Object.freeze({});
    const errors = [];
    const context = new ValidationContext(schema, documentAST, typeInfo, (error)=>{
        if (options.maxErrors != null && errors.length >= options.maxErrors) {
            errors.push(new GraphQLError('Too many validation errors, error limit reached. Validation aborted.'));
            throw abortObj;
        }
        errors.push(error);
    });
    const visitor = visitInParallel(rules.map((rule)=>rule(context)
    ));
    try {
        visit(documentAST, visitWithTypeInfo(typeInfo, visitor));
    } catch (e) {
        if (e !== abortObj) {
            throw e;
        }
    }
    return errors;
}
function validateSDL(documentAST, schemaToExtend, rules = specifiedSDLRules) {
    const errors = [];
    const context = new SDLValidationContext(documentAST, schemaToExtend, (error)=>{
        errors.push(error);
    });
    const visitors = rules.map((rule)=>rule(context)
    );
    visit(documentAST, visitInParallel(visitors));
    return errors;
}
function assertValidSDL(documentAST) {
    const errors = validateSDL(documentAST);
    if (errors.length !== 0) {
        throw new Error(errors.map((error)=>error.message
        ).join('\n\n'));
    }
}
function assertValidSDLExtension(documentAST, schema) {
    const errors = validateSDL(documentAST, schema);
    if (errors.length !== 0) {
        throw new Error(errors.map((error)=>error.message
        ).join('\n\n'));
    }
}
function memoize3(fn) {
    let cache0;
    function memoized(a1, a2, a3) {
        if (!cache0) {
            cache0 = new WeakMap();
        }
        let cache1 = cache0.get(a1);
        let cache2;
        if (cache1) {
            cache2 = cache1.get(a2);
            if (cache2) {
                const cachedValue = cache2.get(a3);
                if (cachedValue !== undefined) {
                    return cachedValue;
                }
            }
        } else {
            cache1 = new WeakMap();
            cache0.set(a1, cache1);
        }
        if (!cache2) {
            cache2 = new WeakMap();
            cache1.set(a2, cache2);
        }
        const newValue = fn(a1, a2, a3);
        cache2.set(a3, newValue);
        return newValue;
    }
    return memoized;
}
function promiseReduce(values8, callback, initialValue) {
    return values8.reduce((previous, value)=>isPromise(previous) ? previous.then((resolved)=>callback(resolved, value)
        ) : callback(previous, value)
    , initialValue);
}
function promiseForObject(object) {
    const keys3 = Object.keys(object);
    const valuesAndPromises = keys3.map((name)=>object[name]
    );
    return Promise.all(valuesAndPromises).then((values9)=>values9.reduce((resolvedObject, value, i)=>{
            resolvedObject[keys3[i]] = value;
            return resolvedObject;
        }, Object.create(null))
    );
}
function addPath(prev, key) {
    return {
        prev,
        key
    };
}
function pathToArray(path4) {
    const flattened = [];
    let curr = path4;
    while(curr){
        flattened.push(curr.key);
        curr = curr.prev;
    }
    return flattened.reverse();
}
function getOperationRootType(schema, operation) {
    if (operation.operation === 'query') {
        const queryType = schema.getQueryType();
        if (!queryType) {
            throw new GraphQLError('Schema does not define the required query root type.', operation);
        }
        return queryType;
    }
    if (operation.operation === 'mutation') {
        const mutationType = schema.getMutationType();
        if (!mutationType) {
            throw new GraphQLError('Schema is not configured for mutations.', operation);
        }
        return mutationType;
    }
    if (operation.operation === 'subscription') {
        const subscriptionType = schema.getSubscriptionType();
        if (!subscriptionType) {
            throw new GraphQLError('Schema is not configured for subscriptions.', operation);
        }
        return subscriptionType;
    }
    throw new GraphQLError('Can only have query, mutation and subscription operations.', operation);
}
function printPathArray(path5) {
    return path5.map((key)=>typeof key === 'number' ? '[' + key.toString() + ']' : '.' + key
    ).join('');
}
function valueFromAST(valueNode, type72, variables) {
    if (!valueNode) {
        return;
    }
    if (valueNode.kind === Kind.VARIABLE) {
        const variableName = valueNode.name.value;
        if (variables == null || variables[variableName] === undefined) {
            return;
        }
        const variableValue = variables[variableName];
        if (variableValue === null && isNonNullType(type72)) {
            return;
        }
        return variableValue;
    }
    if (isNonNullType(type72)) {
        if (valueNode.kind === Kind.NULL) {
            return;
        }
        return valueFromAST(valueNode, type72.ofType, variables);
    }
    if (valueNode.kind === Kind.NULL) {
        return null;
    }
    if (isListType(type72)) {
        const itemType = type72.ofType;
        if (valueNode.kind === Kind.LIST) {
            const coercedValues = [];
            for (const itemNode of valueNode.values){
                if (isMissingVariable(itemNode, variables)) {
                    if (isNonNullType(itemType)) {
                        return;
                    }
                    coercedValues.push(null);
                } else {
                    const itemValue = valueFromAST(itemNode, itemType, variables);
                    if (itemValue === undefined) {
                        return;
                    }
                    coercedValues.push(itemValue);
                }
            }
            return coercedValues;
        }
        const coercedValue = valueFromAST(valueNode, itemType, variables);
        if (coercedValue === undefined) {
            return;
        }
        return [
            coercedValue
        ];
    }
    if (isInputObjectType(type72)) {
        if (valueNode.kind !== Kind.OBJECT) {
            return;
        }
        const coercedObj = Object.create(null);
        const fieldNodes = keyMap(valueNode.fields, (field)=>field.name.value
        );
        for (const field1 of objectValues(type72.getFields())){
            const fieldNode = fieldNodes[field1.name];
            if (!fieldNode || isMissingVariable(fieldNode.value, variables)) {
                if (field1.defaultValue !== undefined) {
                    coercedObj[field1.name] = field1.defaultValue;
                } else if (isNonNullType(field1.type)) {
                    return;
                }
                continue;
            }
            const fieldValue = valueFromAST(fieldNode.value, field1.type, variables);
            if (fieldValue === undefined) {
                return;
            }
            coercedObj[field1.name] = fieldValue;
        }
        return coercedObj;
    }
    if (isLeafType(type72)) {
        let result;
        try {
            result = type72.parseLiteral(valueNode, variables);
        } catch (_error) {
            return;
        }
        if (result === undefined) {
            return;
        }
        return result;
    }
    invariant(false, 'Unexpected input type: ' + inspect(type72));
}
function isMissingVariable(valueNode, variables) {
    return valueNode.kind === Kind.VARIABLE && (variables == null || variables[valueNode.name.value] === undefined);
}
function coerceInputValue(inputValue, type73, onError = defaultOnError) {
    return coerceInputValueImpl(inputValue, type73, onError);
}
function defaultOnError(path6, invalidValue, error) {
    let errorPrefix = 'Invalid value ' + inspect(invalidValue);
    if (path6.length > 0) {
        errorPrefix += ` at "value${printPathArray(path6)}"`;
    }
    error.message = errorPrefix + ': ' + error.message;
    throw error;
}
function coerceInputValueImpl(inputValue, type74, onError, path7) {
    if (isNonNullType(type74)) {
        if (inputValue != null) {
            return coerceInputValueImpl(inputValue, type74.ofType, onError, path7);
        }
        onError(pathToArray(path7), inputValue, new GraphQLError(`Expected non-nullable type "${inspect(type74)}" not to be null.`));
        return;
    }
    if (inputValue == null) {
        return null;
    }
    if (isListType(type74)) {
        const itemType = type74.ofType;
        if (isCollection(inputValue)) {
            return arrayFrom(inputValue, (itemValue, index2)=>{
                const itemPath = addPath(path7, index2);
                return coerceInputValueImpl(itemValue, itemType, onError, itemPath);
            });
        }
        return [
            coerceInputValueImpl(inputValue, itemType, onError, path7)
        ];
    }
    if (isInputObjectType(type74)) {
        if (!isObjectLike(inputValue)) {
            onError(pathToArray(path7), inputValue, new GraphQLError(`Expected type "${type74.name}" to be an object.`));
            return;
        }
        const coercedValue = {};
        const fieldDefs = type74.getFields();
        for (const field of objectValues(fieldDefs)){
            const fieldValue = inputValue[field.name];
            if (fieldValue === undefined) {
                if (field.defaultValue !== undefined) {
                    coercedValue[field.name] = field.defaultValue;
                } else if (isNonNullType(field.type)) {
                    const typeStr = inspect(field.type);
                    onError(pathToArray(path7), inputValue, new GraphQLError(`Field "${field.name}" of required type "${typeStr}" was not provided.`));
                }
                continue;
            }
            coercedValue[field.name] = coerceInputValueImpl(fieldValue, field.type, onError, addPath(path7, field.name));
        }
        for (const fieldName of Object.keys(inputValue)){
            if (!fieldDefs[fieldName]) {
                const suggestions = suggestionList(fieldName, Object.keys(type74.getFields()));
                onError(pathToArray(path7), inputValue, new GraphQLError(`Field "${fieldName}" is not defined by type "${type74.name}".` + didYouMean(suggestions)));
            }
        }
        return coercedValue;
    }
    if (isLeafType(type74)) {
        let parseResult;
        try {
            parseResult = type74.parseValue(inputValue);
        } catch (error) {
            if (error instanceof GraphQLError) {
                onError(pathToArray(path7), inputValue, error);
            } else {
                onError(pathToArray(path7), inputValue, new GraphQLError(`Expected type "${type74.name}". ` + error.message, undefined, undefined, undefined, undefined, error));
            }
            return;
        }
        if (parseResult === undefined) {
            onError(pathToArray(path7), inputValue, new GraphQLError(`Expected type "${type74.name}".`));
        }
        return parseResult;
    }
    invariant(false, 'Unexpected input type: ' + inspect(type74));
}
function getVariableValues(schema, varDefNodes, inputs, options) {
    const errors = [];
    const maxErrors = options?.maxErrors;
    try {
        const coerced = coerceVariableValues(schema, varDefNodes, inputs, (error)=>{
            if (maxErrors != null && errors.length >= maxErrors) {
                throw new GraphQLError('Too many errors processing variables, error limit reached. Execution aborted.');
            }
            errors.push(error);
        });
        if (errors.length === 0) {
            return {
                coerced
            };
        }
    } catch (error) {
        errors.push(error);
    }
    return {
        errors
    };
}
function coerceVariableValues(schema, varDefNodes, inputs, onError) {
    const coercedValues = {};
    for (const varDefNode of varDefNodes){
        const varName = varDefNode.variable.name.value;
        const varType = typeFromAST(schema, varDefNode.type);
        if (!isInputType(varType)) {
            const varTypeStr = print(varDefNode.type);
            onError(new GraphQLError(`Variable "$${varName}" expected value of type "${varTypeStr}" which cannot be used as an input type.`, varDefNode.type));
            continue;
        }
        if (!hasOwnProperty(inputs, varName)) {
            if (varDefNode.defaultValue) {
                coercedValues[varName] = valueFromAST(varDefNode.defaultValue, varType);
            } else if (isNonNullType(varType)) {
                const varTypeStr = inspect(varType);
                onError(new GraphQLError(`Variable "$${varName}" of required type "${varTypeStr}" was not provided.`, varDefNode));
            }
            continue;
        }
        const value = inputs[varName];
        if (value === null && isNonNullType(varType)) {
            const varTypeStr = inspect(varType);
            onError(new GraphQLError(`Variable "$${varName}" of non-null type "${varTypeStr}" must not be null.`, varDefNode));
            continue;
        }
        coercedValues[varName] = coerceInputValue(value, varType, (path8, invalidValue, error)=>{
            let prefix = `Variable "$${varName}" got invalid value ` + inspect(invalidValue);
            if (path8.length > 0) {
                prefix += ` at "${varName}${printPathArray(path8)}"`;
            }
            onError(new GraphQLError(prefix + '; ' + error.message, varDefNode, undefined, undefined, undefined, error.originalError));
        });
    }
    return coercedValues;
}
function getArgumentValues(def, node, variableValues) {
    const coercedValues = {};
    const argumentNodes = node.arguments ?? [];
    const argNodeMap = keyMap(argumentNodes, (arg)=>arg.name.value
    );
    for (const argDef of def.args){
        const name = argDef.name;
        const argType = argDef.type;
        const argumentNode = argNodeMap[name];
        if (!argumentNode) {
            if (argDef.defaultValue !== undefined) {
                coercedValues[name] = argDef.defaultValue;
            } else if (isNonNullType(argType)) {
                throw new GraphQLError(`Argument "${name}" of required type "${inspect(argType)}" ` + 'was not provided.', node);
            }
            continue;
        }
        const valueNode = argumentNode.value;
        let isNull = valueNode.kind === Kind.NULL;
        if (valueNode.kind === Kind.VARIABLE) {
            const variableName = valueNode.name.value;
            if (variableValues == null || !hasOwnProperty(variableValues, variableName)) {
                if (argDef.defaultValue !== undefined) {
                    coercedValues[name] = argDef.defaultValue;
                } else if (isNonNullType(argType)) {
                    throw new GraphQLError(`Argument "${name}" of required type "${inspect(argType)}" ` + `was provided the variable "$${variableName}" which was not provided a runtime value.`, valueNode);
                }
                continue;
            }
            isNull = variableValues[variableName] == null;
        }
        if (isNull && isNonNullType(argType)) {
            throw new GraphQLError(`Argument "${name}" of non-null type "${inspect(argType)}" ` + 'must not be null.', valueNode);
        }
        const coercedValue = valueFromAST(valueNode, argType, variableValues);
        if (coercedValue === undefined) {
            throw new GraphQLError(`Argument "${name}" has invalid value ${print(valueNode)}.`, valueNode);
        }
        coercedValues[name] = coercedValue;
    }
    return coercedValues;
}
function getDirectiveValues(directiveDef, node, variableValues) {
    const directiveNode = node.directives && find(node.directives, (directive)=>directive.name.value === directiveDef.name
    );
    if (directiveNode) {
        return getArgumentValues(directiveDef, directiveNode, variableValues);
    }
}
function hasOwnProperty(obj, prop1) {
    return Object.prototype.hasOwnProperty.call(obj, prop1);
}
function execute(argsOrSchema, document, rootValue, contextValue, variableValues, operationName, fieldResolver, typeResolver) {
    return arguments.length === 1 ? executeImpl(argsOrSchema) : executeImpl({
        schema: argsOrSchema,
        document,
        rootValue,
        contextValue,
        variableValues,
        operationName,
        fieldResolver,
        typeResolver
    });
}
function executeImpl(args) {
    const { schema , document , rootValue , contextValue , variableValues , operationName , fieldResolver , typeResolver  } = args;
    assertValidExecutionArguments(schema, document, variableValues);
    const exeContext = buildExecutionContext(schema, document, rootValue, contextValue, variableValues, operationName, fieldResolver, typeResolver);
    if (Array.isArray(exeContext)) {
        return {
            errors: exeContext
        };
    }
    const data = executeOperation(exeContext, exeContext.operation, rootValue);
    return buildResponse(exeContext, data);
}
function buildResponse(exeContext, data) {
    if (isPromise(data)) {
        return data.then((resolved)=>buildResponse(exeContext, resolved)
        );
    }
    return exeContext.errors.length === 0 ? {
        data
    } : {
        errors: exeContext.errors,
        data
    };
}
function assertValidExecutionArguments(schema, document, rawVariableValues) {
    devAssert(document, 'Must provide document.');
    assertValidSchema(schema);
    devAssert(rawVariableValues == null || isObjectLike(rawVariableValues), 'Variables must be provided as an Object where each property is a variable value. Perhaps look to see if an unparsed JSON string was provided.');
}
function buildExecutionContext(schema, document, rootValue, contextValue, rawVariableValues, operationName, fieldResolver, typeResolver) {
    let operation;
    const fragments = Object.create(null);
    for (const definition of document.definitions){
        switch(definition.kind){
            case Kind.OPERATION_DEFINITION:
                if (operationName == null) {
                    if (operation !== undefined) {
                        return [
                            new GraphQLError('Must provide operation name if query contains multiple operations.')
                        ];
                    }
                    operation = definition;
                } else if (definition.name?.value === operationName) {
                    operation = definition;
                }
                break;
            case Kind.FRAGMENT_DEFINITION:
                fragments[definition.name.value] = definition;
                break;
        }
    }
    if (!operation) {
        if (operationName != null) {
            return [
                new GraphQLError(`Unknown operation named "${operationName}".`)
            ];
        }
        return [
            new GraphQLError('Must provide an operation.')
        ];
    }
    const variableDefinitions = operation.variableDefinitions ?? [];
    const coercedVariableValues = getVariableValues(schema, variableDefinitions, rawVariableValues ?? {}, {
        maxErrors: 50
    });
    if (coercedVariableValues.errors) {
        return coercedVariableValues.errors;
    }
    return {
        schema,
        fragments,
        rootValue,
        contextValue,
        operation,
        variableValues: coercedVariableValues.coerced,
        fieldResolver: fieldResolver ?? defaultFieldResolver,
        typeResolver: typeResolver ?? defaultTypeResolver,
        errors: []
    };
}
function executeOperation(exeContext, operation, rootValue) {
    const type75 = getOperationRootType(exeContext.schema, operation);
    const fields = collectFields(exeContext, type75, operation.selectionSet, Object.create(null), Object.create(null));
    const path9 = undefined;
    try {
        const result = operation.operation === 'mutation' ? executeFieldsSerially(exeContext, type75, rootValue, path9, fields) : executeFields(exeContext, type75, rootValue, path9, fields);
        if (isPromise(result)) {
            return result.then(undefined, (error)=>{
                exeContext.errors.push(error);
                return Promise.resolve(null);
            });
        }
        return result;
    } catch (error) {
        exeContext.errors.push(error);
        return null;
    }
}
function executeFieldsSerially(exeContext, parentType, sourceValue, path10, fields) {
    return promiseReduce(Object.keys(fields), (results, responseName)=>{
        const fieldNodes = fields[responseName];
        const fieldPath = addPath(path10, responseName);
        const result = resolveField(exeContext, parentType, sourceValue, fieldNodes, fieldPath);
        if (result === undefined) {
            return results;
        }
        if (isPromise(result)) {
            return result.then((resolvedResult)=>{
                results[responseName] = resolvedResult;
                return results;
            });
        }
        results[responseName] = result;
        return results;
    }, Object.create(null));
}
function executeFields(exeContext, parentType, sourceValue, path11, fields) {
    const results = Object.create(null);
    let containsPromise = false;
    for (const responseName of Object.keys(fields)){
        const fieldNodes = fields[responseName];
        const fieldPath = addPath(path11, responseName);
        const result = resolveField(exeContext, parentType, sourceValue, fieldNodes, fieldPath);
        if (result !== undefined) {
            results[responseName] = result;
            if (!containsPromise && isPromise(result)) {
                containsPromise = true;
            }
        }
    }
    if (!containsPromise) {
        return results;
    }
    return promiseForObject(results);
}
function collectFields(exeContext, runtimeType, selectionSet, fields, visitedFragmentNames) {
    for (const selection of selectionSet.selections){
        switch(selection.kind){
            case Kind.FIELD:
                {
                    if (!shouldIncludeNode(exeContext, selection)) {
                        continue;
                    }
                    const name = getFieldEntryKey(selection);
                    if (!fields[name]) {
                        fields[name] = [];
                    }
                    fields[name].push(selection);
                    break;
                }
            case Kind.INLINE_FRAGMENT:
                {
                    if (!shouldIncludeNode(exeContext, selection) || !doesFragmentConditionMatch(exeContext, selection, runtimeType)) {
                        continue;
                    }
                    collectFields(exeContext, runtimeType, selection.selectionSet, fields, visitedFragmentNames);
                    break;
                }
            case Kind.FRAGMENT_SPREAD:
                {
                    const fragName = selection.name.value;
                    if (visitedFragmentNames[fragName] || !shouldIncludeNode(exeContext, selection)) {
                        continue;
                    }
                    visitedFragmentNames[fragName] = true;
                    const fragment = exeContext.fragments[fragName];
                    if (!fragment || !doesFragmentConditionMatch(exeContext, fragment, runtimeType)) {
                        continue;
                    }
                    collectFields(exeContext, runtimeType, fragment.selectionSet, fields, visitedFragmentNames);
                    break;
                }
        }
    }
    return fields;
}
function shouldIncludeNode(exeContext, node) {
    const skip = getDirectiveValues(GraphQLSkipDirective, node, exeContext.variableValues);
    if (skip?.if === true) {
        return false;
    }
    const include = getDirectiveValues(GraphQLIncludeDirective, node, exeContext.variableValues);
    if (include?.if === false) {
        return false;
    }
    return true;
}
function doesFragmentConditionMatch(exeContext, fragment, type76) {
    const typeConditionNode = fragment.typeCondition;
    if (!typeConditionNode) {
        return true;
    }
    const conditionalType = typeFromAST(exeContext.schema, typeConditionNode);
    if (conditionalType === type76) {
        return true;
    }
    if (isAbstractType(conditionalType)) {
        return exeContext.schema.isSubType(conditionalType, type76);
    }
    return false;
}
function getFieldEntryKey(node) {
    return node.alias ? node.alias.value : node.name.value;
}
function resolveField(exeContext, parentType, source, fieldNodes, path12) {
    const fieldNode = fieldNodes[0];
    const fieldName = fieldNode.name.value;
    const fieldDef = getFieldDef1(exeContext.schema, parentType, fieldName);
    if (!fieldDef) {
        return;
    }
    const resolveFn = fieldDef.resolve ?? exeContext.fieldResolver;
    const info = buildResolveInfo(exeContext, fieldDef, fieldNodes, parentType, path12);
    const result = resolveFieldValueOrError(exeContext, fieldDef, fieldNodes, resolveFn, source, info);
    return completeValueCatchingError(exeContext, fieldDef.type, fieldNodes, info, path12, result);
}
function buildResolveInfo(exeContext, fieldDef, fieldNodes, parentType, path13) {
    return {
        fieldName: fieldDef.name,
        fieldNodes,
        returnType: fieldDef.type,
        parentType,
        path: path13,
        schema: exeContext.schema,
        fragments: exeContext.fragments,
        rootValue: exeContext.rootValue,
        operation: exeContext.operation,
        variableValues: exeContext.variableValues
    };
}
function resolveFieldValueOrError(exeContext, fieldDef, fieldNodes, resolveFn, source, info) {
    try {
        const args = getArgumentValues(fieldDef, fieldNodes[0], exeContext.variableValues);
        const contextValue = exeContext.contextValue;
        const result = resolveFn(source, args, contextValue, info);
        return isPromise(result) ? result.then(undefined, asErrorInstance) : result;
    } catch (error) {
        return asErrorInstance(error);
    }
}
function asErrorInstance(error) {
    if (error instanceof Error) {
        return error;
    }
    return new Error('Unexpected error value: ' + inspect(error));
}
function completeValueCatchingError(exeContext, returnType, fieldNodes, info, path14, result) {
    try {
        let completed;
        if (isPromise(result)) {
            completed = result.then((resolved)=>completeValue(exeContext, returnType, fieldNodes, info, path14, resolved)
            );
        } else {
            completed = completeValue(exeContext, returnType, fieldNodes, info, path14, result);
        }
        if (isPromise(completed)) {
            return completed.then(undefined, (error)=>handleFieldError(error, fieldNodes, path14, returnType, exeContext)
            );
        }
        return completed;
    } catch (error) {
        return handleFieldError(error, fieldNodes, path14, returnType, exeContext);
    }
}
function handleFieldError(rawError, fieldNodes, path15, returnType, exeContext) {
    const error = locatedError(asErrorInstance(rawError), fieldNodes, pathToArray(path15));
    if (isNonNullType(returnType)) {
        throw error;
    }
    exeContext.errors.push(error);
    return null;
}
function completeValue(exeContext, returnType, fieldNodes, info, path16, result) {
    if (result instanceof Error) {
        throw result;
    }
    if (isNonNullType(returnType)) {
        const completed = completeValue(exeContext, returnType.ofType, fieldNodes, info, path16, result);
        if (completed === null) {
            throw new Error(`Cannot return null for non-nullable field ${info.parentType.name}.${info.fieldName}.`);
        }
        return completed;
    }
    if (result == null) {
        return null;
    }
    if (isListType(returnType)) {
        return completeListValue(exeContext, returnType, fieldNodes, info, path16, result);
    }
    if (isLeafType(returnType)) {
        return completeLeafValue(returnType, result);
    }
    if (isAbstractType(returnType)) {
        return completeAbstractValue(exeContext, returnType, fieldNodes, info, path16, result);
    }
    if (isObjectType(returnType)) {
        return completeObjectValue(exeContext, returnType, fieldNodes, info, path16, result);
    }
    invariant(false, 'Cannot complete value of unexpected output type: ' + inspect(returnType));
}
function completeListValue(exeContext, returnType, fieldNodes, info, path17, result) {
    if (!isCollection(result)) {
        throw new GraphQLError(`Expected Iterable, but did not find one for field "${info.parentType.name}.${info.fieldName}".`);
    }
    const itemType = returnType.ofType;
    let containsPromise = false;
    const completedResults = arrayFrom(result, (item, index3)=>{
        const fieldPath = addPath(path17, index3);
        const completedItem = completeValueCatchingError(exeContext, itemType, fieldNodes, info, fieldPath, item);
        if (!containsPromise && isPromise(completedItem)) {
            containsPromise = true;
        }
        return completedItem;
    });
    return containsPromise ? Promise.all(completedResults) : completedResults;
}
function completeLeafValue(returnType, result) {
    const serializedResult = returnType.serialize(result);
    if (serializedResult === undefined) {
        throw new Error(`Expected a value of type "${inspect(returnType)}" but ` + `received: ${inspect(result)}`);
    }
    return serializedResult;
}
function completeAbstractValue(exeContext, returnType, fieldNodes, info, path18, result) {
    const resolveTypeFn = returnType.resolveType ?? exeContext.typeResolver;
    const contextValue = exeContext.contextValue;
    const runtimeType = resolveTypeFn(result, contextValue, info, returnType);
    if (isPromise(runtimeType)) {
        return runtimeType.then((resolvedRuntimeType)=>completeObjectValue(exeContext, ensureValidRuntimeType(resolvedRuntimeType, exeContext, returnType, fieldNodes, info, result), fieldNodes, info, path18, result)
        );
    }
    return completeObjectValue(exeContext, ensureValidRuntimeType(runtimeType, exeContext, returnType, fieldNodes, info, result), fieldNodes, info, path18, result);
}
function ensureValidRuntimeType(runtimeTypeOrName, exeContext, returnType, fieldNodes, info, result) {
    const runtimeType = typeof runtimeTypeOrName === 'string' ? exeContext.schema.getType(runtimeTypeOrName) : runtimeTypeOrName;
    if (!isObjectType(runtimeType)) {
        throw new GraphQLError(`Abstract type "${returnType.name}" must resolve to an Object type at runtime for field "${info.parentType.name}.${info.fieldName}" with ` + `value ${inspect(result)}, received "${inspect(runtimeType)}". ` + `Either the "${returnType.name}" type should provide a "resolveType" function or each possible type should provide an "isTypeOf" function.`, fieldNodes);
    }
    if (!exeContext.schema.isSubType(returnType, runtimeType)) {
        throw new GraphQLError(`Runtime Object type "${runtimeType.name}" is not a possible type for "${returnType.name}".`, fieldNodes);
    }
    return runtimeType;
}
function completeObjectValue(exeContext, returnType, fieldNodes, info, path19, result) {
    if (returnType.isTypeOf) {
        const isTypeOf = returnType.isTypeOf(result, exeContext.contextValue, info);
        if (isPromise(isTypeOf)) {
            return isTypeOf.then((resolvedIsTypeOf)=>{
                if (!resolvedIsTypeOf) {
                    throw invalidReturnTypeError(returnType, result, fieldNodes);
                }
                return collectAndExecuteSubfields(exeContext, returnType, fieldNodes, path19, result);
            });
        }
        if (!isTypeOf) {
            throw invalidReturnTypeError(returnType, result, fieldNodes);
        }
    }
    return collectAndExecuteSubfields(exeContext, returnType, fieldNodes, path19, result);
}
function invalidReturnTypeError(returnType, result, fieldNodes) {
    return new GraphQLError(`Expected value of type "${returnType.name}" but got: ${inspect(result)}.`, fieldNodes);
}
function collectAndExecuteSubfields(exeContext, returnType, fieldNodes, path20, result) {
    const subFieldNodes = collectSubfields(exeContext, returnType, fieldNodes);
    return executeFields(exeContext, returnType, result, path20, subFieldNodes);
}
const collectSubfields = memoize3(_collectSubfields);
function _collectSubfields(exeContext, returnType, fieldNodes) {
    let subFieldNodes = Object.create(null);
    const visitedFragmentNames = Object.create(null);
    for (const node of fieldNodes){
        if (node.selectionSet) {
            subFieldNodes = collectFields(exeContext, returnType, node.selectionSet, subFieldNodes, visitedFragmentNames);
        }
    }
    return subFieldNodes;
}
const defaultTypeResolver = function(value, contextValue, info, abstractType) {
    if (isObjectLike(value) && typeof value.__typename === 'string') {
        return value.__typename;
    }
    const possibleTypes = info.schema.getPossibleTypes(abstractType);
    const promisedIsTypeOfResults = [];
    for(let i1 = 0; i1 < possibleTypes.length; i1++){
        const type77 = possibleTypes[i1];
        if (type77.isTypeOf) {
            const isTypeOfResult = type77.isTypeOf(value, contextValue, info);
            if (isPromise(isTypeOfResult)) {
                promisedIsTypeOfResults[i1] = isTypeOfResult;
            } else if (isTypeOfResult) {
                return type77;
            }
        }
    }
    if (promisedIsTypeOfResults.length) {
        return Promise.all(promisedIsTypeOfResults).then((isTypeOfResults)=>{
            for(let i21 = 0; i21 < isTypeOfResults.length; i21++){
                if (isTypeOfResults[i21]) {
                    return possibleTypes[i21];
                }
            }
        });
    }
};
const defaultFieldResolver = function(source, args, contextValue, info) {
    if (isObjectLike(source) || typeof source === 'function') {
        const property = source[info.fieldName];
        if (typeof property === 'function') {
            return source[info.fieldName](args, contextValue, info);
        }
        return property;
    }
};
function getFieldDef1(schema, parentType, fieldName) {
    if (fieldName === SchemaMetaFieldDef.name && schema.getQueryType() === parentType) {
        return SchemaMetaFieldDef;
    } else if (fieldName === TypeMetaFieldDef.name && schema.getQueryType() === parentType) {
        return TypeMetaFieldDef;
    } else if (fieldName === TypeNameMetaFieldDef.name) {
        return TypeNameMetaFieldDef;
    }
    return parentType.getFields()[fieldName];
}
function graphql(argsOrSchema, source, rootValue, contextValue, variableValues, operationName, fieldResolver, typeResolver) {
    return new Promise((resolve)=>resolve(arguments.length === 1 ? graphqlImpl(argsOrSchema) : graphqlImpl({
            schema: argsOrSchema,
            source,
            rootValue,
            contextValue,
            variableValues,
            operationName,
            fieldResolver,
            typeResolver
        }))
    );
}
function graphqlImpl(args) {
    const { schema , source , rootValue , contextValue , variableValues , operationName , fieldResolver , typeResolver  } = args;
    const schemaValidationErrors = validateSchema(schema);
    if (schemaValidationErrors.length > 0) {
        return {
            errors: schemaValidationErrors
        };
    }
    let document;
    try {
        document = parse1(source);
    } catch (syntaxError1) {
        return {
            errors: [
                syntaxError1
            ]
        };
    }
    const validationErrors = validate(schema, document);
    if (validationErrors.length > 0) {
        return {
            errors: validationErrors
        };
    }
    return execute({
        schema,
        document,
        rootValue,
        contextValue,
        variableValues,
        operationName,
        fieldResolver,
        typeResolver
    });
}
function extendSchema(schema, documentAST, options) {
    assertSchema(schema);
    devAssert(documentAST != null && documentAST.kind === Kind.DOCUMENT, 'Must provide valid Document AST.');
    if (options?.assumeValid !== true && options?.assumeValidSDL !== true) {
        assertValidSDLExtension(documentAST, schema);
    }
    const schemaConfig = schema.toConfig();
    const extendedConfig = extendSchemaImpl(schemaConfig, documentAST, options);
    return schemaConfig === extendedConfig ? schema : new GraphQLSchema(extendedConfig);
}
function extendSchemaImpl(schemaConfig, documentAST, options) {
    const typeDefs1 = [];
    const typeExtensionsMap = Object.create(null);
    const directiveDefs = [];
    let schemaDef;
    const schemaExtensions = [];
    for (const def of documentAST.definitions){
        if (def.kind === Kind.SCHEMA_DEFINITION) {
            schemaDef = def;
        } else if (def.kind === Kind.SCHEMA_EXTENSION) {
            schemaExtensions.push(def);
        } else if (isTypeDefinitionNode(def)) {
            typeDefs1.push(def);
        } else if (isTypeExtensionNode(def)) {
            const extendedTypeName = def.name.value;
            const existingTypeExtensions = typeExtensionsMap[extendedTypeName];
            typeExtensionsMap[extendedTypeName] = existingTypeExtensions ? existingTypeExtensions.concat([
                def
            ]) : [
                def
            ];
        } else if (def.kind === Kind.DIRECTIVE_DEFINITION) {
            directiveDefs.push(def);
        }
    }
    if (Object.keys(typeExtensionsMap).length === 0 && typeDefs1.length === 0 && directiveDefs.length === 0 && schemaExtensions.length === 0 && schemaDef == null) {
        return schemaConfig;
    }
    const typeMap = Object.create(null);
    for (const existingType of schemaConfig.types){
        typeMap[existingType.name] = extendNamedType(existingType);
    }
    for (const typeNode of typeDefs1){
        const name = typeNode.name.value;
        typeMap[name] = stdTypeMap[name] ?? buildType(typeNode);
    }
    const operationTypes = {
        query: schemaConfig.query && replaceNamedType(schemaConfig.query),
        mutation: schemaConfig.mutation && replaceNamedType(schemaConfig.mutation),
        subscription: schemaConfig.subscription && replaceNamedType(schemaConfig.subscription),
        ...schemaDef && getOperationTypes([
            schemaDef
        ]),
        ...getOperationTypes(schemaExtensions)
    };
    return {
        description: schemaDef?.description?.value,
        ...operationTypes,
        types: objectValues(typeMap),
        directives: [
            ...schemaConfig.directives.map(replaceDirective),
            ...directiveDefs.map(buildDirective)
        ],
        extensions: undefined,
        astNode: schemaDef ?? schemaConfig.astNode,
        extensionASTNodes: schemaConfig.extensionASTNodes.concat(schemaExtensions),
        assumeValid: options?.assumeValid ?? false
    };
    function replaceType(type78) {
        if (isListType(type78)) {
            return new GraphQLList(replaceType(type78.ofType));
        } else if (isNonNullType(type78)) {
            return new GraphQLNonNull(replaceType(type78.ofType));
        }
        return replaceNamedType(type78);
    }
    function replaceNamedType(type) {
        return typeMap[type.name];
    }
    function replaceDirective(directive) {
        const config = directive.toConfig();
        return new GraphQLDirective({
            ...config,
            args: mapValue(config.args, extendArg)
        });
    }
    function extendNamedType(type79) {
        if (isIntrospectionType(type79) || isSpecifiedScalarType(type79)) {
            return type79;
        }
        if (isScalarType(type79)) {
            return extendScalarType(type79);
        }
        if (isObjectType(type79)) {
            return extendObjectType(type79);
        }
        if (isInterfaceType(type79)) {
            return extendInterfaceType(type79);
        }
        if (isUnionType(type79)) {
            return extendUnionType(type79);
        }
        if (isEnumType(type79)) {
            return extendEnumType(type79);
        }
        if (isInputObjectType(type79)) {
            return extendInputObjectType(type79);
        }
        invariant(false, 'Unexpected type: ' + inspect(type79));
    }
    function extendInputObjectType(type80) {
        const config = type80.toConfig();
        const extensions = typeExtensionsMap[config.name] ?? [];
        return new GraphQLInputObjectType({
            ...config,
            fields: ()=>({
                    ...mapValue(config.fields, (field)=>({
                            ...field,
                            type: replaceType(field.type)
                        })
                    ),
                    ...buildInputFieldMap(extensions)
                })
            ,
            extensionASTNodes: config.extensionASTNodes.concat(extensions)
        });
    }
    function extendEnumType(type81) {
        const config = type81.toConfig();
        const extensions = typeExtensionsMap[type81.name] ?? [];
        return new GraphQLEnumType({
            ...config,
            values: {
                ...config.values,
                ...buildEnumValueMap(extensions)
            },
            extensionASTNodes: config.extensionASTNodes.concat(extensions)
        });
    }
    function extendScalarType(type82) {
        const config = type82.toConfig();
        const extensions = typeExtensionsMap[config.name] ?? [];
        return new GraphQLScalarType({
            ...config,
            extensionASTNodes: config.extensionASTNodes.concat(extensions)
        });
    }
    function extendObjectType(type83) {
        const config = type83.toConfig();
        const extensions = typeExtensionsMap[config.name] ?? [];
        return new GraphQLObjectType({
            ...config,
            interfaces: ()=>[
                    ...type83.getInterfaces().map(replaceNamedType),
                    ...buildInterfaces(extensions)
                ]
            ,
            fields: ()=>({
                    ...mapValue(config.fields, extendField),
                    ...buildFieldMap(extensions)
                })
            ,
            extensionASTNodes: config.extensionASTNodes.concat(extensions)
        });
    }
    function extendInterfaceType(type84) {
        const config = type84.toConfig();
        const extensions = typeExtensionsMap[config.name] ?? [];
        return new GraphQLInterfaceType({
            ...config,
            interfaces: ()=>[
                    ...type84.getInterfaces().map(replaceNamedType),
                    ...buildInterfaces(extensions)
                ]
            ,
            fields: ()=>({
                    ...mapValue(config.fields, extendField),
                    ...buildFieldMap(extensions)
                })
            ,
            extensionASTNodes: config.extensionASTNodes.concat(extensions)
        });
    }
    function extendUnionType(type85) {
        const config = type85.toConfig();
        const extensions = typeExtensionsMap[config.name] ?? [];
        return new GraphQLUnionType({
            ...config,
            types: ()=>[
                    ...type85.getTypes().map(replaceNamedType),
                    ...buildUnionTypes(extensions)
                ]
            ,
            extensionASTNodes: config.extensionASTNodes.concat(extensions)
        });
    }
    function extendField(field) {
        return {
            ...field,
            type: replaceType(field.type),
            args: mapValue(field.args, extendArg)
        };
    }
    function extendArg(arg) {
        return {
            ...arg,
            type: replaceType(arg.type)
        };
    }
    function getOperationTypes(nodes) {
        const opTypes = {};
        for (const node of nodes){
            const operationTypesNodes = node.operationTypes ?? [];
            for (const operationType of operationTypesNodes){
                opTypes[operationType.operation] = getNamedType1(operationType.type);
            }
        }
        return opTypes;
    }
    function getNamedType1(node) {
        const name = node.name.value;
        const type86 = stdTypeMap[name] ?? typeMap[name];
        if (type86 === undefined) {
            throw new Error(`Unknown type: "${name}".`);
        }
        return type86;
    }
    function getWrappedType(node) {
        if (node.kind === Kind.LIST_TYPE) {
            return new GraphQLList(getWrappedType(node.type));
        }
        if (node.kind === Kind.NON_NULL_TYPE) {
            return new GraphQLNonNull(getWrappedType(node.type));
        }
        return getNamedType1(node);
    }
    function buildDirective(node) {
        const locations = node.locations.map(({ value  })=>value
        );
        return new GraphQLDirective({
            name: node.name.value,
            description: getDescription(node, options),
            locations,
            isRepeatable: node.repeatable,
            args: buildArgumentMap(node.arguments),
            astNode: node
        });
    }
    function buildFieldMap(nodes) {
        const fieldConfigMap = Object.create(null);
        for (const node of nodes){
            const nodeFields = node.fields ?? [];
            for (const field of nodeFields){
                fieldConfigMap[field.name.value] = {
                    type: getWrappedType(field.type),
                    description: getDescription(field, options),
                    args: buildArgumentMap(field.arguments),
                    deprecationReason: getDeprecationReason(field),
                    astNode: field
                };
            }
        }
        return fieldConfigMap;
    }
    function buildArgumentMap(args) {
        const argsNodes = args ?? [];
        const argConfigMap = Object.create(null);
        for (const arg of argsNodes){
            const type87 = getWrappedType(arg.type);
            argConfigMap[arg.name.value] = {
                type: type87,
                description: getDescription(arg, options),
                defaultValue: valueFromAST(arg.defaultValue, type87),
                astNode: arg
            };
        }
        return argConfigMap;
    }
    function buildInputFieldMap(nodes) {
        const inputFieldMap = Object.create(null);
        for (const node of nodes){
            const fieldsNodes = node.fields ?? [];
            for (const field of fieldsNodes){
                const type88 = getWrappedType(field.type);
                inputFieldMap[field.name.value] = {
                    type: type88,
                    description: getDescription(field, options),
                    defaultValue: valueFromAST(field.defaultValue, type88),
                    astNode: field
                };
            }
        }
        return inputFieldMap;
    }
    function buildEnumValueMap(nodes) {
        const enumValueMap = Object.create(null);
        for (const node of nodes){
            const valuesNodes = node.values ?? [];
            for (const value of valuesNodes){
                enumValueMap[value.name.value] = {
                    description: getDescription(value, options),
                    deprecationReason: getDeprecationReason(value),
                    astNode: value
                };
            }
        }
        return enumValueMap;
    }
    function buildInterfaces(nodes) {
        const interfaces = [];
        for (const node of nodes){
            const interfacesNodes = node.interfaces ?? [];
            for (const type89 of interfacesNodes){
                interfaces.push(getNamedType1(type89));
            }
        }
        return interfaces;
    }
    function buildUnionTypes(nodes) {
        const types = [];
        for (const node of nodes){
            const typeNodes = node.types ?? [];
            for (const type90 of typeNodes){
                types.push(getNamedType1(type90));
            }
        }
        return types;
    }
    function buildType(astNode) {
        const name = astNode.name.value;
        const description = getDescription(astNode, options);
        const extensionNodes = typeExtensionsMap[name] ?? [];
        switch(astNode.kind){
            case Kind.OBJECT_TYPE_DEFINITION:
                {
                    const extensionASTNodes = extensionNodes;
                    const allNodes = [
                        astNode,
                        ...extensionASTNodes
                    ];
                    return new GraphQLObjectType({
                        name,
                        description,
                        interfaces: ()=>buildInterfaces(allNodes)
                        ,
                        fields: ()=>buildFieldMap(allNodes)
                        ,
                        astNode,
                        extensionASTNodes
                    });
                }
            case Kind.INTERFACE_TYPE_DEFINITION:
                {
                    const extensionASTNodes = extensionNodes;
                    const allNodes = [
                        astNode,
                        ...extensionASTNodes
                    ];
                    return new GraphQLInterfaceType({
                        name,
                        description,
                        interfaces: ()=>buildInterfaces(allNodes)
                        ,
                        fields: ()=>buildFieldMap(allNodes)
                        ,
                        astNode,
                        extensionASTNodes
                    });
                }
            case Kind.ENUM_TYPE_DEFINITION:
                {
                    const extensionASTNodes = extensionNodes;
                    const allNodes = [
                        astNode,
                        ...extensionASTNodes
                    ];
                    return new GraphQLEnumType({
                        name,
                        description,
                        values: buildEnumValueMap(allNodes),
                        astNode,
                        extensionASTNodes
                    });
                }
            case Kind.UNION_TYPE_DEFINITION:
                {
                    const extensionASTNodes = extensionNodes;
                    const allNodes = [
                        astNode,
                        ...extensionASTNodes
                    ];
                    return new GraphQLUnionType({
                        name,
                        description,
                        types: ()=>buildUnionTypes(allNodes)
                        ,
                        astNode,
                        extensionASTNodes
                    });
                }
            case Kind.SCALAR_TYPE_DEFINITION:
                {
                    const extensionASTNodes = extensionNodes;
                    return new GraphQLScalarType({
                        name,
                        description,
                        astNode,
                        extensionASTNodes
                    });
                }
            case Kind.INPUT_OBJECT_TYPE_DEFINITION:
                {
                    const extensionASTNodes = extensionNodes;
                    const allNodes = [
                        astNode,
                        ...extensionASTNodes
                    ];
                    return new GraphQLInputObjectType({
                        name,
                        description,
                        fields: ()=>buildInputFieldMap(allNodes)
                        ,
                        astNode,
                        extensionASTNodes
                    });
                }
        }
        invariant(false, 'Unexpected type definition node: ' + inspect(astNode));
    }
}
const stdTypeMap = keyMap(specifiedScalarTypes.concat(introspectionTypes), (type91)=>type91.name
);
function getDeprecationReason(node) {
    const deprecated = getDirectiveValues(GraphQLDeprecatedDirective, node);
    return deprecated?.reason;
}
function getDescription(node, options) {
    if (node.description) {
        return node.description.value;
    }
    if (options?.commentDescriptions === true) {
        const rawValue = getLeadingCommentBlock(node);
        if (rawValue !== undefined) {
            return dedentBlockStringValue('\n' + rawValue);
        }
    }
}
function getLeadingCommentBlock(node) {
    const loc = node.loc;
    if (!loc) {
        return;
    }
    const comments = [];
    let token = loc.startToken.prev;
    while(token != null && token.kind === TokenKind.COMMENT && token.next && token.prev && token.line + 1 === token.next.line && token.line !== token.prev.line){
        const value = String(token.value);
        comments.push(value);
        token = token.prev;
    }
    return comments.length > 0 ? comments.reverse().join('\n') : undefined;
}
function buildASTSchema(documentAST, options) {
    devAssert(documentAST != null && documentAST.kind === Kind.DOCUMENT, 'Must provide valid Document AST.');
    if (options?.assumeValid !== true && options?.assumeValidSDL !== true) {
        assertValidSDL(documentAST);
    }
    const config = extendSchemaImpl(emptySchemaConfig, documentAST, options);
    if (config.astNode == null) {
        for (const type92 of config.types){
            switch(type92.name){
                case 'Query':
                    config.query = type92;
                    break;
                case 'Mutation':
                    config.mutation = type92;
                    break;
                case 'Subscription':
                    config.subscription = type92;
                    break;
            }
        }
    }
    const { directives  } = config;
    if (!directives.some((directive)=>directive.name === 'skip'
    )) {
        directives.push(GraphQLSkipDirective);
    }
    if (!directives.some((directive)=>directive.name === 'include'
    )) {
        directives.push(GraphQLIncludeDirective);
    }
    if (!directives.some((directive)=>directive.name === 'deprecated'
    )) {
        directives.push(GraphQLDeprecatedDirective);
    }
    return new GraphQLSchema(config);
}
const emptySchemaConfig = new GraphQLSchema({
    directives: []
}).toConfig();
Object.freeze({
    TYPE_REMOVED: 'TYPE_REMOVED',
    TYPE_CHANGED_KIND: 'TYPE_CHANGED_KIND',
    TYPE_REMOVED_FROM_UNION: 'TYPE_REMOVED_FROM_UNION',
    VALUE_REMOVED_FROM_ENUM: 'VALUE_REMOVED_FROM_ENUM',
    REQUIRED_INPUT_FIELD_ADDED: 'REQUIRED_INPUT_FIELD_ADDED',
    IMPLEMENTED_INTERFACE_REMOVED: 'IMPLEMENTED_INTERFACE_REMOVED',
    FIELD_REMOVED: 'FIELD_REMOVED',
    FIELD_CHANGED_KIND: 'FIELD_CHANGED_KIND',
    REQUIRED_ARG_ADDED: 'REQUIRED_ARG_ADDED',
    ARG_REMOVED: 'ARG_REMOVED',
    ARG_CHANGED_KIND: 'ARG_CHANGED_KIND',
    DIRECTIVE_REMOVED: 'DIRECTIVE_REMOVED',
    DIRECTIVE_ARG_REMOVED: 'DIRECTIVE_ARG_REMOVED',
    REQUIRED_DIRECTIVE_ARG_ADDED: 'REQUIRED_DIRECTIVE_ARG_ADDED',
    DIRECTIVE_REPEATABLE_REMOVED: 'DIRECTIVE_REPEATABLE_REMOVED',
    DIRECTIVE_LOCATION_REMOVED: 'DIRECTIVE_LOCATION_REMOVED'
});
Object.freeze({
    VALUE_ADDED_TO_ENUM: 'VALUE_ADDED_TO_ENUM',
    TYPE_ADDED_TO_UNION: 'TYPE_ADDED_TO_UNION',
    OPTIONAL_INPUT_FIELD_ADDED: 'OPTIONAL_INPUT_FIELD_ADDED',
    OPTIONAL_ARG_ADDED: 'OPTIONAL_ARG_ADDED',
    IMPLEMENTED_INTERFACE_ADDED: 'IMPLEMENTED_INTERFACE_ADDED',
    ARG_DEFAULT_VALUE_CHANGE: 'ARG_DEFAULT_VALUE_CHANGE'
});
async function runHttpQuery(params, options, context) {
    const contextValue = options.context && context?.request ? await options.context?.(context?.request) : context;
    const source = params.query || params.mutation;
    return await graphql({
        source,
        ...options,
        contextValue,
        variableValues: params.variables,
        operationName: params.operationName
    });
}
new TextDecoder();
function GraphQLHTTP({ playgroundOptions ={} , headers ={} , ...options }) {
    return async (request)=>{
        if (options.graphiql && request.method === 'GET') {
            if (request.headers.get('Accept')?.includes('text/html')) {
                const { renderPlaygroundPage  } = await import('./graphiql/render.ts');
                const playground = renderPlaygroundPage({
                    ...playgroundOptions,
                    endpoint: '/graphql'
                });
                return new Response(playground, {
                    headers: new Headers({
                        'Content-Type': 'text/html',
                        ...headers
                    })
                });
            } else {
                return new Response('"Accept" header value must include text/html', {
                    status: 400,
                    headers: new Headers(headers)
                });
            }
        } else {
            if (![
                'PUT',
                'POST',
                'PATCH'
            ].includes(request.method)) {
                return new Response('Method Not Allowed', {
                    status: 405,
                    headers: new Headers(headers)
                });
            } else {
                try {
                    const result = await runHttpQuery(await request.json(), options, {
                        request
                    });
                    return new Response(JSON.stringify(result, null, 2), {
                        status: 200,
                        headers: new Headers({
                            'Content-Type': 'application/json',
                            ...headers
                        })
                    });
                } catch (e) {
                    console.error(e);
                    return new Response('Malformed request body', {
                        status: 400,
                        headers: new Headers(headers)
                    });
                }
            }
        }
    };
}
function isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
}
function mergeDeep(target, ...sources) {
    const output = {
        ...target
    };
    sources.forEach((source)=>{
        if (isObject(target) && isObject(source)) {
            Object.keys(source).forEach((key)=>{
                if (isObject(source[key])) {
                    if (!(key in target)) {
                        Object.assign(output, {
                            [key]: source[key]
                        });
                    } else {
                        output[key] = mergeDeep(target[key], source[key]);
                    }
                } else {
                    Object.assign(output, {
                        [key]: source[key]
                    });
                }
            });
        }
    });
    return output;
}
var VisitSchemaKind;
(function(VisitSchemaKind1) {
    VisitSchemaKind1["TYPE"] = 'VisitSchemaKind.TYPE';
    VisitSchemaKind1["SCALAR_TYPE"] = 'VisitSchemaKind.SCALAR_TYPE';
    VisitSchemaKind1["ENUM_TYPE"] = 'VisitSchemaKind.ENUM_TYPE';
    VisitSchemaKind1["COMPOSITE_TYPE"] = 'VisitSchemaKind.COMPOSITE_TYPE';
    VisitSchemaKind1["OBJECT_TYPE"] = 'VisitSchemaKind.OBJECT_TYPE';
    VisitSchemaKind1["INPUT_OBJECT_TYPE"] = 'VisitSchemaKind.INPUT_OBJECT_TYPE';
    VisitSchemaKind1["ABSTRACT_TYPE"] = 'VisitSchemaKind.ABSTRACT_TYPE';
    VisitSchemaKind1["UNION_TYPE"] = 'VisitSchemaKind.UNION_TYPE';
    VisitSchemaKind1["INTERFACE_TYPE"] = 'VisitSchemaKind.INTERFACE_TYPE';
    VisitSchemaKind1["ROOT_OBJECT"] = 'VisitSchemaKind.ROOT_OBJECT';
    VisitSchemaKind1["QUERY"] = 'VisitSchemaKind.QUERY';
    VisitSchemaKind1["MUTATION"] = 'VisitSchemaKind.MUTATION';
    VisitSchemaKind1["SUBSCRIPTION"] = 'VisitSchemaKind.SUBSCRIPTION';
})(VisitSchemaKind || (VisitSchemaKind = {}));
var MapperKind;
(function(MapperKind1) {
    MapperKind1["TYPE"] = 'MapperKind.TYPE';
    MapperKind1["SCALAR_TYPE"] = 'MapperKind.SCALAR_TYPE';
    MapperKind1["ENUM_TYPE"] = 'MapperKind.ENUM_TYPE';
    MapperKind1["COMPOSITE_TYPE"] = 'MapperKind.COMPOSITE_TYPE';
    MapperKind1["OBJECT_TYPE"] = 'MapperKind.OBJECT_TYPE';
    MapperKind1["INPUT_OBJECT_TYPE"] = 'MapperKind.INPUT_OBJECT_TYPE';
    MapperKind1["ABSTRACT_TYPE"] = 'MapperKind.ABSTRACT_TYPE';
    MapperKind1["UNION_TYPE"] = 'MapperKind.UNION_TYPE';
    MapperKind1["INTERFACE_TYPE"] = 'MapperKind.INTERFACE_TYPE';
    MapperKind1["ROOT_OBJECT"] = 'MapperKind.ROOT_OBJECT';
    MapperKind1["QUERY"] = 'MapperKind.QUERY';
    MapperKind1["MUTATION"] = 'MapperKind.MUTATION';
    MapperKind1["SUBSCRIPTION"] = 'MapperKind.SUBSCRIPTION';
    MapperKind1["DIRECTIVE"] = 'MapperKind.DIRECTIVE';
    MapperKind1["FIELD"] = 'MapperKind.FIELD';
    MapperKind1["COMPOSITE_FIELD"] = 'MapperKind.COMPOSITE_FIELD';
    MapperKind1["OBJECT_FIELD"] = 'MapperKind.OBJECT_FIELD';
    MapperKind1["ROOT_FIELD"] = 'MapperKind.ROOT_FIELD';
    MapperKind1["QUERY_ROOT_FIELD"] = 'MapperKind.QUERY_ROOT_FIELD';
    MapperKind1["MUTATION_ROOT_FIELD"] = 'MapperKind.MUTATION_ROOT_FIELD';
    MapperKind1["SUBSCRIPTION_ROOT_FIELD"] = 'MapperKind.SUBSCRIPTION_ROOT_FIELD';
    MapperKind1["INTERFACE_FIELD"] = 'MapperKind.INTERFACE_FIELD';
    MapperKind1["INPUT_OBJECT_FIELD"] = 'MapperKind.INPUT_OBJECT_FIELD';
    MapperKind1["ARGUMENT"] = 'MapperKind.ARGUMENT';
    MapperKind1["ENUM_VALUE"] = 'MapperKind.ENUM_VALUE';
})(MapperKind || (MapperKind = {}));
class SchemaVisitor {
    schema;
    static implementsVisitorMethod(methodName) {
        if (!methodName.startsWith('visit')) {
            return false;
        }
        const method = this.prototype[methodName];
        if (typeof method !== 'function') {
            return false;
        }
        if (this.name === 'SchemaVisitor') {
            return true;
        }
        const stub = SchemaVisitor.prototype[methodName];
        if (method === stub) {
            return false;
        }
        return true;
    }
    visitSchema(_schema) {}
    visitScalar(_scalar) {}
    visitObject(_object) {}
    visitFieldDefinition(_field, _details) {}
    visitArgumentDefinition(_argument, _details) {}
    visitInterface(_iface) {}
    visitUnion(_union) {}
    visitEnum(_type) {}
    visitEnumValue(_value, _details) {}
    visitInputObject(_object) {}
    visitInputFieldDefinition(_field, _details) {}
}
function isNamedStub(type93) {
    if (isObjectType(type93) || isInterfaceType(type93) || isInputObjectType(type93)) {
        const fields = type93.getFields();
        const fieldNames = Object.keys(fields);
        return fieldNames.length === 1 && fields[fieldNames[0]].name === '__fake';
    }
    return false;
}
function getBuiltInForStub(type94) {
    switch(type94.name){
        case GraphQLInt.name:
            return GraphQLInt;
        case GraphQLFloat.name:
            return GraphQLFloat;
        case GraphQLString.name:
            return GraphQLString;
        case GraphQLBoolean.name:
            return GraphQLBoolean;
        case GraphQLID.name:
            return GraphQLID;
        default:
            return type94;
    }
}
function rewireTypes(originalTypeMap, directives, options = {
    skipPruning: false
}) {
    const newTypeMap = Object.create(null);
    Object.keys(originalTypeMap).forEach((typeName)=>{
        const namedType = originalTypeMap[typeName];
        if (namedType == null || typeName.startsWith('__')) {
            return;
        }
        const newName = namedType.name;
        if (newName.startsWith('__')) {
            return;
        }
        if (newTypeMap[newName] != null) {
            throw new Error(`Duplicate schema type name ${newName}`);
        }
        newTypeMap[newName] = namedType;
    });
    Object.keys(newTypeMap).forEach((typeName)=>{
        newTypeMap[typeName] = rewireNamedType(newTypeMap[typeName]);
    });
    const newDirectives = directives.map((directive)=>rewireDirective(directive)
    );
    return options.skipPruning ? {
        typeMap: newTypeMap,
        directives: newDirectives
    } : pruneTypes(newTypeMap, newDirectives);
    function rewireDirective(directive) {
        const directiveConfig = directive.toConfig();
        directiveConfig.args = rewireArgs(directiveConfig.args);
        return new GraphQLDirective(directiveConfig);
    }
    function rewireArgs(args) {
        const rewiredArgs = {};
        Object.keys(args).forEach((argName)=>{
            const arg = args[argName];
            const rewiredArgType = rewireType(arg.type);
            if (rewiredArgType != null) {
                arg.type = rewiredArgType;
                rewiredArgs[argName] = arg;
            }
        });
        return rewiredArgs;
    }
    function rewireNamedType(type95) {
        if (isObjectType(type95)) {
            const config = type95.toConfig();
            const newConfig = {
                ...config,
                fields: ()=>rewireFields(config.fields)
                ,
                interfaces: ()=>rewireNamedTypes(config.interfaces)
            };
            return new GraphQLObjectType(newConfig);
        } else if (isInterfaceType(type95)) {
            const config = type95.toConfig();
            const newConfig = {
                ...config,
                fields: ()=>rewireFields(config.fields)
            };
            if ('interfaces' in newConfig) {
                newConfig.interfaces = ()=>rewireNamedTypes(config.interfaces)
                ;
            }
            return new GraphQLInterfaceType(newConfig);
        } else if (isUnionType(type95)) {
            const config = type95.toConfig();
            const newConfig = {
                ...config,
                types: ()=>rewireNamedTypes(config.types)
            };
            return new GraphQLUnionType(newConfig);
        } else if (isInputObjectType(type95)) {
            const config = type95.toConfig();
            const newConfig = {
                ...config,
                fields: ()=>rewireInputFields(config.fields)
            };
            return new GraphQLInputObjectType(newConfig);
        } else if (isEnumType(type95)) {
            const enumConfig = type95.toConfig();
            return new GraphQLEnumType(enumConfig);
        } else if (isScalarType(type95)) {
            if (isSpecifiedScalarType(type95)) {
                return type95;
            }
            const scalarConfig = type95.toConfig();
            return new GraphQLScalarType(scalarConfig);
        }
        throw new Error(`Unexpected schema type: ${type95}`);
    }
    function rewireFields(fields) {
        const rewiredFields = {};
        Object.keys(fields).forEach((fieldName)=>{
            const field = fields[fieldName];
            const rewiredFieldType = rewireType(field.type);
            if (rewiredFieldType != null) {
                field.type = rewiredFieldType;
                field.args = rewireArgs(field.args);
                rewiredFields[fieldName] = field;
            }
        });
        return rewiredFields;
    }
    function rewireInputFields(fields) {
        const rewiredFields = {};
        Object.keys(fields).forEach((fieldName)=>{
            const field = fields[fieldName];
            const rewiredFieldType = rewireType(field.type);
            if (rewiredFieldType != null) {
                field.type = rewiredFieldType;
                rewiredFields[fieldName] = field;
            }
        });
        return rewiredFields;
    }
    function rewireNamedTypes(namedTypes) {
        const rewiredTypes = [];
        namedTypes.forEach((namedType)=>{
            const rewiredType = rewireType(namedType);
            if (rewiredType != null) {
                rewiredTypes.push(rewiredType);
            }
        });
        return rewiredTypes;
    }
    function rewireType(type96) {
        if (isListType(type96)) {
            const rewiredType = rewireType(type96.ofType);
            return rewiredType != null ? new GraphQLList(rewiredType) : null;
        } else if (isNonNullType(type96)) {
            const rewiredType = rewireType(type96.ofType);
            return rewiredType != null ? new GraphQLNonNull(rewiredType) : null;
        } else if (isNamedType(type96)) {
            let rewiredType = originalTypeMap[type96.name];
            if (rewiredType === undefined) {
                rewiredType = isNamedStub(type96) ? getBuiltInForStub(type96) : type96;
                newTypeMap[rewiredType.name] = rewiredType;
            }
            return rewiredType != null ? newTypeMap[rewiredType.name] : null;
        }
        return null;
    }
}
function pruneTypes(typeMap, directives) {
    const newTypeMap = {};
    const implementedInterfaces = {};
    Object.keys(typeMap).forEach((typeName)=>{
        const namedType = typeMap[typeName];
        if ('getInterfaces' in namedType) {
            namedType.getInterfaces().forEach((iface)=>{
                implementedInterfaces[iface.name] = true;
            });
        }
    });
    let prunedTypeMap = false;
    const typeNames = Object.keys(typeMap);
    for(let i22 = 0; i22 < typeNames.length; i22++){
        const typeName = typeNames[i22];
        const type97 = typeMap[typeName];
        if (isObjectType(type97) || isInputObjectType(type97)) {
            if (Object.keys(type97.getFields()).length) {
                newTypeMap[typeName] = type97;
            } else {
                prunedTypeMap = true;
            }
        } else if (isUnionType(type97)) {
            if (type97.getTypes().length) {
                newTypeMap[typeName] = type97;
            } else {
                prunedTypeMap = true;
            }
        } else if (isInterfaceType(type97)) {
            if (Object.keys(type97.getFields()).length && implementedInterfaces[type97.name]) {
                newTypeMap[typeName] = type97;
            } else {
                prunedTypeMap = true;
            }
        } else {
            newTypeMap[typeName] = type97;
        }
    }
    return prunedTypeMap ? rewireTypes(newTypeMap, directives) : {
        typeMap,
        directives
    };
}
function transformInputValue(type98, value, transformer) {
    if (value == null) {
        return value;
    }
    const nullableType = getNullableType(type98);
    if (isLeafType(nullableType)) {
        return transformer(nullableType, value);
    } else if (isListType(nullableType)) {
        return value.map((listMember)=>transformInputValue(nullableType.ofType, listMember, transformer)
        );
    } else if (isInputObjectType(nullableType)) {
        const fields = nullableType.getFields();
        const newValue = {};
        Object.keys(value).forEach((key)=>{
            newValue[key] = transformInputValue(fields[key].type, value[key], transformer);
        });
        return newValue;
    }
}
function serializeInputValue(type99, value) {
    return transformInputValue(type99, value, (t, v)=>t.serialize(v)
    );
}
function parseInputValue(type100, value) {
    return transformInputValue(type100, value, (t, v)=>t.parseValue(v)
    );
}
function healSchema(schema) {
    healTypes(schema.getTypeMap(), schema.getDirectives());
    return schema;
}
function healTypes(originalTypeMap, directives, config = {
    skipPruning: false
}) {
    const actualNamedTypeMap = Object.create(null);
    Object.entries(originalTypeMap).forEach(([typeName, namedType])=>{
        if (namedType == null || typeName.startsWith('__')) {
            return;
        }
        const actualName = namedType.name;
        if (actualName.startsWith('__')) {
            return;
        }
        if (actualName in actualNamedTypeMap) {
            throw new Error(`Duplicate schema type name ${actualName}`);
        }
        actualNamedTypeMap[actualName] = namedType;
    });
    Object.entries(actualNamedTypeMap).forEach(([typeName, namedType])=>{
        originalTypeMap[typeName] = namedType;
    });
    directives.forEach((decl)=>{
        decl.args = decl.args.filter((arg)=>{
            arg.type = healType(arg.type);
            return arg.type !== null;
        });
    });
    Object.entries(originalTypeMap).forEach(([typeName, namedType])=>{
        if (!typeName.startsWith('__') && typeName in actualNamedTypeMap) {
            if (namedType != null) {
                healNamedType(namedType);
            }
        }
    });
    for (const typeName1 of Object.keys(originalTypeMap)){
        if (!typeName1.startsWith('__') && !(typeName1 in actualNamedTypeMap)) {
            delete originalTypeMap[typeName1];
        }
    }
    if (!config.skipPruning) {
        pruneTypes1(originalTypeMap, directives);
    }
    function healNamedType(type101) {
        if (isObjectType(type101)) {
            healFields(type101);
            healInterfaces(type101);
            return;
        } else if (isInterfaceType(type101)) {
            healFields(type101);
            if ('getInterfaces' in type101) {
                healInterfaces(type101);
            }
            return;
        } else if (isUnionType(type101)) {
            healUnderlyingTypes(type101);
            return;
        } else if (isInputObjectType(type101)) {
            healInputFields(type101);
            return;
        } else if (isLeafType(type101)) {
            return;
        }
        throw new Error(`Unexpected schema type: ${type101}`);
    }
    function healFields(type102) {
        const fieldMap = type102.getFields();
        for (const [key, field] of Object.entries(fieldMap)){
            field.args.map((arg)=>{
                arg.type = healType(arg.type);
                return arg.type === null ? null : arg;
            }).filter(Boolean);
            field.type = healType(field.type);
            if (field.type === null) {
                delete fieldMap[key];
            }
        }
    }
    function healInterfaces(type103) {
        if ('getInterfaces' in type103) {
            const interfaces = type103.getInterfaces();
            interfaces.push(...interfaces.splice(0).map((iface)=>healType(iface)
            ).filter(Boolean));
        }
    }
    function healInputFields(type104) {
        const fieldMap = type104.getFields();
        for (const [key, field] of Object.entries(fieldMap)){
            field.type = healType(field.type);
            if (field.type === null) {
                delete fieldMap[key];
            }
        }
    }
    function healUnderlyingTypes(type105) {
        const types = type105.getTypes();
        types.push(...types.splice(0).map((t)=>healType(t)
        ).filter(Boolean));
    }
    function healType(type106) {
        if (isListType(type106)) {
            const healedType = healType(type106.ofType);
            return healedType != null ? new GraphQLList(healedType) : null;
        } else if (isNonNullType(type106)) {
            const healedType = healType(type106.ofType);
            return healedType != null ? new GraphQLNonNull(healedType) : null;
        } else if (isNamedType(type106)) {
            const officialType = originalTypeMap[type106.name];
            if (officialType && type106 !== officialType) {
                return officialType;
            }
        }
        return type106;
    }
}
function pruneTypes1(typeMap, directives) {
    const implementedInterfaces = {};
    Object.values(typeMap).forEach((namedType)=>{
        if ('getInterfaces' in namedType) {
            namedType.getInterfaces().forEach((iface)=>{
                implementedInterfaces[iface.name] = true;
            });
        }
    });
    let prunedTypeMap = false;
    const typeNames = Object.keys(typeMap);
    for(let i23 = 0; i23 < typeNames.length; i23++){
        const typeName = typeNames[i23];
        const type107 = typeMap[typeName];
        if (isObjectType(type107) || isInputObjectType(type107)) {
            if (!Object.keys(type107.getFields()).length) {
                typeMap[typeName] = null;
                prunedTypeMap = true;
            }
        } else if (isUnionType(type107)) {
            if (!type107.getTypes().length) {
                typeMap[typeName] = null;
                prunedTypeMap = true;
            }
        } else if (isInterfaceType(type107)) {
            if (!Object.keys(type107.getFields()).length || !(type107.name in implementedInterfaces)) {
                typeMap[typeName] = null;
                prunedTypeMap = true;
            }
        }
    }
    if (prunedTypeMap) {
        healTypes(typeMap, directives);
    }
}
function inspect1(value) {
    return formatValue1(value, []);
}
function formatValue1(value, seenValues) {
    switch(typeof value){
        case 'string':
            return JSON.stringify(value);
        case 'function':
            return value.name ? `[function ${value.name}]` : '[function]';
        case 'object':
            if (value === null) {
                return 'null';
            }
            return formatObjectValue1(value, seenValues);
        default:
            return String(value);
    }
}
function formatObjectValue1(value, previouslySeenValues) {
    if (previouslySeenValues.indexOf(value) !== -1) {
        return '[Circular]';
    }
    const seenValues = [
        ...previouslySeenValues,
        value
    ];
    const customInspectFn = getCustomFn1(value);
    if (customInspectFn !== undefined) {
        const customValue = customInspectFn.call(value);
        if (customValue !== value) {
            return typeof customValue === 'string' ? customValue : formatValue1(customValue, seenValues);
        }
    } else if (Array.isArray(value)) {
        return formatArray1(value, seenValues);
    }
    return formatObject1(value, seenValues);
}
function formatObject1(object, seenValues) {
    const keys4 = Object.keys(object);
    if (keys4.length === 0) {
        return '{}';
    }
    if (seenValues.length > 2) {
        return '[' + getObjectTag1(object) + ']';
    }
    const properties = keys4.map((key)=>{
        const value = formatValue1(object[key], seenValues);
        return key + ': ' + value;
    });
    return '{ ' + properties.join(', ') + ' }';
}
function formatArray1(array, seenValues) {
    if (array.length === 0) {
        return '[]';
    }
    if (seenValues.length > 2) {
        return '[Array]';
    }
    const len = Math.min(10, array.length);
    const remaining = array.length - len;
    const items = [];
    for(let i24 = 0; i24 < len; ++i24){
        items.push(formatValue1(array[i24], seenValues));
    }
    if (remaining === 1) {
        items.push('... 1 more item');
    } else if (remaining > 1) {
        items.push(`... ${remaining.toString(10)} more items`);
    }
    return '[' + items.join(', ') + ']';
}
function getCustomFn1(obj) {
    if (typeof obj.inspect === 'function') {
        return obj.inspect;
    }
}
function getObjectTag1(obj) {
    const tag = Object.prototype.toString.call(obj).replace(/^\[object /, '').replace(/]$/, '');
    if (tag === 'Object' && typeof obj.constructor === 'function') {
        const name = obj.constructor.name;
        if (typeof name === 'string' && name !== '') {
            return name;
        }
    }
    return tag;
}
function mapSchema(schema, schemaMapper = {}) {
    const originalTypeMap = schema.getTypeMap();
    let newTypeMap = mapDefaultValues(originalTypeMap, schema, serializeInputValue);
    newTypeMap = mapTypes(newTypeMap, schema, schemaMapper, (type108)=>isLeafType(type108)
    );
    newTypeMap = mapEnumValues(newTypeMap, schema, schemaMapper);
    newTypeMap = mapDefaultValues(newTypeMap, schema, parseInputValue);
    newTypeMap = mapTypes(newTypeMap, schema, schemaMapper, (type109)=>!isLeafType(type109)
    );
    newTypeMap = mapFields(newTypeMap, schema, schemaMapper);
    newTypeMap = mapArguments(newTypeMap, schema, schemaMapper);
    const originalDirectives = schema.getDirectives();
    const newDirectives = mapDirectives(originalDirectives, schema, schemaMapper);
    const queryType = schema.getQueryType();
    const mutationType = schema.getMutationType();
    const subscriptionType = schema.getSubscriptionType();
    const newQueryTypeName = queryType != null ? newTypeMap[queryType.name] != null ? newTypeMap[queryType.name].name : undefined : undefined;
    const newMutationTypeName = mutationType != null ? newTypeMap[mutationType.name] != null ? newTypeMap[mutationType.name].name : undefined : undefined;
    const newSubscriptionTypeName = subscriptionType != null ? newTypeMap[subscriptionType.name] != null ? newTypeMap[subscriptionType.name].name : undefined : undefined;
    const { typeMap , directives  } = rewireTypes(newTypeMap, newDirectives);
    return new GraphQLSchema({
        ...schema.toConfig(),
        query: newQueryTypeName ? typeMap[newQueryTypeName] : undefined,
        mutation: newMutationTypeName ? typeMap[newMutationTypeName] : undefined,
        subscription: newSubscriptionTypeName != null ? typeMap[newSubscriptionTypeName] : undefined,
        types: Object.keys(typeMap).map((typeName)=>typeMap[typeName]
        ),
        directives
    });
}
function mapTypes(originalTypeMap, schema, schemaMapper, testFn = ()=>true
) {
    const newTypeMap = {};
    Object.keys(originalTypeMap).forEach((typeName)=>{
        if (!typeName.startsWith('__')) {
            const originalType = originalTypeMap[typeName];
            if (originalType == null || !testFn(originalType)) {
                newTypeMap[typeName] = originalType;
                return;
            }
            const typeMapper = getTypeMapper(schema, schemaMapper, typeName);
            if (typeMapper == null) {
                newTypeMap[typeName] = originalType;
                return;
            }
            const maybeNewType = typeMapper(originalType, schema);
            if (maybeNewType === undefined) {
                newTypeMap[typeName] = originalType;
                return;
            }
            newTypeMap[typeName] = maybeNewType;
        }
    });
    return newTypeMap;
}
function mapEnumValues(originalTypeMap, schema, schemaMapper) {
    const enumValueMapper = getEnumValueMapper(schemaMapper);
    if (!enumValueMapper) {
        return originalTypeMap;
    }
    return mapTypes(originalTypeMap, schema, {
        [MapperKind.ENUM_TYPE]: (type110)=>{
            const config = type110.toConfig();
            const originalEnumValueConfigMap = config.values;
            const newEnumValueConfigMap = {};
            Object.keys(originalEnumValueConfigMap).forEach((enumValueName)=>{
                const originalEnumValueConfig = originalEnumValueConfigMap[enumValueName];
                const mappedEnumValue = enumValueMapper(originalEnumValueConfig, type110.name, schema);
                if (mappedEnumValue === undefined) {
                    newEnumValueConfigMap[enumValueName] = originalEnumValueConfig;
                } else if (Array.isArray(mappedEnumValue)) {
                    const [newEnumValueName, newEnumValueConfig] = mappedEnumValue;
                    newEnumValueConfigMap[newEnumValueName] = newEnumValueConfig;
                } else if (mappedEnumValue !== null) {
                    newEnumValueConfigMap[enumValueName] = mappedEnumValue;
                }
            });
            return new GraphQLEnumType({
                ...config,
                values: newEnumValueConfigMap
            });
        }
    }, (type111)=>isEnumType(type111)
    );
}
function mapDefaultValues(originalTypeMap, schema, fn) {
    const newTypeMap = mapArguments(originalTypeMap, schema, {
        [MapperKind.ARGUMENT]: (argumentConfig)=>{
            if (argumentConfig.defaultValue === undefined) {
                return argumentConfig;
            }
            const maybeNewType = getNewType(originalTypeMap, argumentConfig.type);
            if (maybeNewType != null) {
                return {
                    ...argumentConfig,
                    defaultValue: fn(maybeNewType, argumentConfig.defaultValue)
                };
            }
        }
    });
    return mapFields(newTypeMap, schema, {
        [MapperKind.INPUT_OBJECT_FIELD]: (inputFieldConfig)=>{
            if (inputFieldConfig.defaultValue === undefined) {
                return inputFieldConfig;
            }
            const maybeNewType = getNewType(newTypeMap, inputFieldConfig.type);
            if (maybeNewType != null) {
                return {
                    ...inputFieldConfig,
                    defaultValue: fn(maybeNewType, inputFieldConfig.defaultValue)
                };
            }
        }
    });
}
function getNewType(newTypeMap, type112) {
    if (isListType(type112)) {
        const newType = getNewType(newTypeMap, type112.ofType);
        return newType != null ? new GraphQLList(newType) : null;
    } else if (isNonNullType(type112)) {
        const newType = getNewType(newTypeMap, type112.ofType);
        return newType != null ? new GraphQLNonNull(newType) : null;
    } else if (isNamedType(type112)) {
        const newType = newTypeMap[type112.name];
        return newType != null ? newType : null;
    }
    return null;
}
function mapFields(originalTypeMap, schema, schemaMapper) {
    const newTypeMap = {};
    Object.keys(originalTypeMap).forEach((typeName)=>{
        if (!typeName.startsWith('__')) {
            const originalType = originalTypeMap[typeName];
            if (!isObjectType(originalType) && !isInterfaceType(originalType) && !isInputObjectType(originalType)) {
                newTypeMap[typeName] = originalType;
                return;
            }
            const fieldMapper = getFieldMapper(schema, schemaMapper, typeName);
            if (fieldMapper == null) {
                newTypeMap[typeName] = originalType;
                return;
            }
            const config = originalType.toConfig();
            const originalFieldConfigMap = config.fields;
            const newFieldConfigMap = {};
            Object.keys(originalFieldConfigMap).forEach((fieldName)=>{
                const originalFieldConfig = originalFieldConfigMap[fieldName];
                const mappedField = fieldMapper(originalFieldConfig, fieldName, typeName, schema);
                if (mappedField === undefined) {
                    newFieldConfigMap[fieldName] = originalFieldConfig;
                } else if (Array.isArray(mappedField)) {
                    const [newFieldName, newFieldConfig] = mappedField;
                    newFieldConfigMap[newFieldName] = newFieldConfig;
                } else if (mappedField !== null) {
                    newFieldConfigMap[fieldName] = mappedField;
                }
            });
            if (isObjectType(originalType)) {
                newTypeMap[typeName] = new GraphQLObjectType({
                    ...config,
                    fields: newFieldConfigMap
                });
            } else if (isInterfaceType(originalType)) {
                newTypeMap[typeName] = new GraphQLInterfaceType({
                    ...config,
                    fields: newFieldConfigMap
                });
            } else {
                newTypeMap[typeName] = new GraphQLInputObjectType({
                    ...config,
                    fields: newFieldConfigMap
                });
            }
        }
    });
    return newTypeMap;
}
function mapArguments(originalTypeMap, schema, schemaMapper) {
    const newTypeMap = {};
    Object.keys(originalTypeMap).forEach((typeName)=>{
        if (!typeName.startsWith('__')) {
            const originalType = originalTypeMap[typeName];
            if (!isObjectType(originalType) && !isInterfaceType(originalType)) {
                newTypeMap[typeName] = originalType;
                return;
            }
            const argumentMapper = getArgumentMapper(schemaMapper);
            if (argumentMapper == null) {
                newTypeMap[typeName] = originalType;
                return;
            }
            const config = originalType.toConfig();
            const originalFieldConfigMap = config.fields;
            const newFieldConfigMap = {};
            Object.keys(originalFieldConfigMap).forEach((fieldName)=>{
                const originalFieldConfig = originalFieldConfigMap[fieldName];
                const originalArgumentConfigMap = originalFieldConfig.args;
                if (originalArgumentConfigMap == null) {
                    newFieldConfigMap[fieldName] = originalFieldConfig;
                    return;
                }
                const argumentNames = Object.keys(originalArgumentConfigMap);
                if (!argumentNames.length) {
                    newFieldConfigMap[fieldName] = originalFieldConfig;
                    return;
                }
                const newArgumentConfigMap = {};
                argumentNames.forEach((argumentName)=>{
                    const originalArgumentConfig = originalArgumentConfigMap[argumentName];
                    const mappedArgument = argumentMapper(originalArgumentConfig, fieldName, typeName, schema);
                    if (mappedArgument === undefined) {
                        newArgumentConfigMap[argumentName] = originalArgumentConfig;
                    } else if (Array.isArray(mappedArgument)) {
                        const [newArgumentName, newArgumentConfig] = mappedArgument;
                        newArgumentConfigMap[newArgumentName] = newArgumentConfig;
                    } else if (mappedArgument !== null) {
                        newArgumentConfigMap[argumentName] = mappedArgument;
                    }
                });
                newFieldConfigMap[fieldName] = {
                    ...originalFieldConfig,
                    args: newArgumentConfigMap
                };
            });
            if (isObjectType(originalType)) {
                newTypeMap[typeName] = new GraphQLObjectType({
                    ...config,
                    fields: newFieldConfigMap
                });
            } else if (isInterfaceType(originalType)) {
                newTypeMap[typeName] = new GraphQLInterfaceType({
                    ...config,
                    fields: newFieldConfigMap
                });
            } else {
                newTypeMap[typeName] = new GraphQLInputObjectType({
                    ...config,
                    fields: newFieldConfigMap
                });
            }
        }
    });
    return newTypeMap;
}
function mapDirectives(originalDirectives, schema, schemaMapper) {
    const directiveMapper = getDirectiveMapper(schemaMapper);
    if (directiveMapper == null) {
        return originalDirectives.slice();
    }
    const newDirectives = [];
    originalDirectives.forEach((directive)=>{
        const mappedDirective = directiveMapper(directive, schema);
        if (mappedDirective === undefined) {
            newDirectives.push(directive);
        } else if (mappedDirective !== null) {
            newDirectives.push(mappedDirective);
        }
    });
    return newDirectives;
}
function getTypeSpecifiers(schema, typeName) {
    const type113 = schema.getType(typeName);
    const specifiers = [
        MapperKind.TYPE
    ];
    if (isObjectType(type113)) {
        specifiers.push(MapperKind.COMPOSITE_TYPE, MapperKind.OBJECT_TYPE);
        const query3 = schema.getQueryType();
        const mutation = schema.getMutationType();
        const subscription = schema.getSubscriptionType();
        if (query3 != null && typeName === query3.name) {
            specifiers.push(MapperKind.ROOT_OBJECT, MapperKind.QUERY);
        } else if (mutation != null && typeName === mutation.name) {
            specifiers.push(MapperKind.ROOT_OBJECT, MapperKind.MUTATION);
        } else if (subscription != null && typeName === subscription.name) {
            specifiers.push(MapperKind.ROOT_OBJECT, MapperKind.SUBSCRIPTION);
        }
    } else if (isInputObjectType(type113)) {
        specifiers.push(MapperKind.INPUT_OBJECT_TYPE);
    } else if (isInterfaceType(type113)) {
        specifiers.push(MapperKind.COMPOSITE_TYPE, MapperKind.ABSTRACT_TYPE, MapperKind.INTERFACE_TYPE);
    } else if (isUnionType(type113)) {
        specifiers.push(MapperKind.COMPOSITE_TYPE, MapperKind.ABSTRACT_TYPE, MapperKind.UNION_TYPE);
    } else if (isEnumType(type113)) {
        specifiers.push(MapperKind.ENUM_TYPE);
    } else if (isScalarType(type113)) {
        specifiers.push(MapperKind.SCALAR_TYPE);
    }
    return specifiers;
}
function getTypeMapper(schema, schemaMapper, typeName) {
    const specifiers = getTypeSpecifiers(schema, typeName);
    let typeMapper;
    const stack = [
        ...specifiers
    ];
    while(!typeMapper && stack.length > 0){
        const next = stack.pop();
        typeMapper = next && schemaMapper[next];
    }
    return typeMapper != null ? typeMapper : null;
}
function getFieldSpecifiers(schema, typeName) {
    const type114 = schema.getType(typeName);
    const specifiers = [
        MapperKind.FIELD
    ];
    if (isObjectType(type114)) {
        specifiers.push(MapperKind.COMPOSITE_FIELD, MapperKind.OBJECT_FIELD);
        const query4 = schema.getQueryType();
        const mutation = schema.getMutationType();
        const subscription = schema.getSubscriptionType();
        if (query4 != null && typeName === query4.name) {
            specifiers.push(MapperKind.ROOT_FIELD, MapperKind.QUERY_ROOT_FIELD);
        } else if (mutation != null && typeName === mutation.name) {
            specifiers.push(MapperKind.ROOT_FIELD, MapperKind.MUTATION_ROOT_FIELD);
        } else if (subscription != null && typeName === subscription.name) {
            specifiers.push(MapperKind.ROOT_FIELD, MapperKind.SUBSCRIPTION_ROOT_FIELD);
        }
    } else if (isInterfaceType(type114)) {
        specifiers.push(MapperKind.COMPOSITE_FIELD, MapperKind.INTERFACE_FIELD);
    } else if (isInputObjectType(type114)) {
        specifiers.push(MapperKind.INPUT_OBJECT_FIELD);
    }
    return specifiers;
}
function getFieldMapper(schema, schemaMapper, typeName) {
    const specifiers = getFieldSpecifiers(schema, typeName);
    let fieldMapper;
    const stack = [
        ...specifiers
    ];
    while(!fieldMapper && stack.length > 0){
        const next = stack.pop();
        fieldMapper = next && schemaMapper[next];
    }
    return fieldMapper != null ? fieldMapper : null;
}
function getArgumentMapper(schemaMapper) {
    const argumentMapper = schemaMapper[MapperKind.ARGUMENT];
    return argumentMapper != null ? argumentMapper : null;
}
function getDirectiveMapper(schemaMapper) {
    const directiveMapper = schemaMapper[MapperKind.DIRECTIVE];
    return directiveMapper != null ? directiveMapper : null;
}
function getEnumValueMapper(schemaMapper) {
    const enumValueMapper = schemaMapper[MapperKind.ENUM_VALUE];
    return enumValueMapper != null ? enumValueMapper : null;
}
function forEachField(schema, fn) {
    const typeMap = schema.getTypeMap();
    Object.keys(typeMap).forEach((typeName)=>{
        const type115 = typeMap[typeName];
        if (!getNamedType(type115).name.startsWith('__') && isObjectType(type115)) {
            const fields = type115.getFields();
            Object.keys(fields).forEach((fieldName)=>{
                const field = fields[fieldName];
                fn(field, typeName, fieldName);
            });
        }
    });
}
function forEachDefaultValue(schema, fn) {
    const typeMap = schema.getTypeMap();
    Object.keys(typeMap).forEach((typeName)=>{
        const type116 = typeMap[typeName];
        if (!getNamedType(type116).name.startsWith('__')) {
            if (isObjectType(type116)) {
                const fields = type116.getFields();
                Object.keys(fields).forEach((fieldName)=>{
                    const field = fields[fieldName];
                    field.args.forEach((arg)=>{
                        arg.defaultValue = fn(arg.type, arg.defaultValue);
                    });
                });
            } else if (isInputObjectType(type116)) {
                const fields = type116.getFields();
                Object.keys(fields).forEach((fieldName)=>{
                    const field = fields[fieldName];
                    field.defaultValue = fn(field.type, field.defaultValue);
                });
            }
        }
    });
}
function getArgumentValues1(def, node, variableValues = {}) {
    const variableMap = Object.entries(variableValues).reduce((prev, [key, value])=>({
            ...prev,
            [key]: value
        })
    , {});
    const coercedValues = {};
    const argumentNodes = node.arguments ?? [];
    const argNodeMap = argumentNodes.reduce((prev, arg)=>({
            ...prev,
            [arg.name.value]: arg
        })
    , {});
    for (const argDef of def.args){
        const name = argDef.name;
        const argType = argDef.type;
        const argumentNode = argNodeMap[name];
        if (!argumentNode) {
            if (argDef.defaultValue !== undefined) {
                coercedValues[name] = argDef.defaultValue;
            } else if (isNonNullType(argType)) {
                throw new GraphQLError(`Argument "${name}" of required type "${inspect1(argType)}" ` + 'was not provided.', node);
            }
            continue;
        }
        const valueNode = argumentNode.value;
        let isNull = valueNode.kind === Kind.NULL;
        if (valueNode.kind === Kind.VARIABLE) {
            const variableName = valueNode.name.value;
            if (variableValues == null || !(variableName in variableMap)) {
                if (argDef.defaultValue !== undefined) {
                    coercedValues[name] = argDef.defaultValue;
                } else if (isNonNullType(argType)) {
                    throw new GraphQLError(`Argument "${name}" of required type "${inspect1(argType)}" ` + `was provided the variable "$${variableName}" which was not provided a runtime value.`, valueNode);
                }
                continue;
            }
            isNull = variableValues[variableName] == null;
        }
        if (isNull && isNonNullType(argType)) {
            throw new GraphQLError(`Argument "${name}" of non-null type "${inspect1(argType)}" ` + 'must not be null.', valueNode);
        }
        const coercedValue = valueFromAST(valueNode, argType, variableValues);
        if (coercedValue === undefined) {
            throw new GraphQLError(`Argument "${name}" has invalid value ${print(valueNode)}.`, valueNode);
        }
        coercedValues[name] = coercedValue;
    }
    return coercedValues;
}
function isSchemaVisitor(obj) {
    if ('schema' in obj && isSchema(obj.schema)) {
        if ('visitSchema' in obj && typeof obj.visitSchema === 'function') {
            return true;
        }
    }
    return false;
}
function visitSchema(schema, visitorOrVisitorSelector) {
    const visitorSelector = typeof visitorOrVisitorSelector === 'function' ? visitorOrVisitorSelector : ()=>visitorOrVisitorSelector
    ;
    function callMethod(methodName, type117, ...args) {
        let visitors = visitorSelector(type117, methodName);
        visitors = Array.isArray(visitors) ? visitors : [
            visitors
        ];
        let finalType = type117;
        visitors.every((visitorOrVisitorDef)=>{
            let newType;
            if (isSchemaVisitor(visitorOrVisitorDef)) {
                newType = visitorOrVisitorDef[methodName](finalType, ...args);
            } else if (isNamedType(finalType) && (methodName === 'visitScalar' || methodName === 'visitEnum' || methodName === 'visitObject' || methodName === 'visitInputObject' || methodName === 'visitUnion' || methodName === 'visitInterface')) {
                const specifiers = getTypeSpecifiers1(finalType, schema);
                const typeVisitor = getVisitor(visitorOrVisitorDef, specifiers);
                newType = typeVisitor != null ? typeVisitor(finalType, schema) : undefined;
            }
            if (typeof newType === 'undefined') {
                return true;
            }
            if (methodName === 'visitSchema' || isSchema(finalType)) {
                throw new Error(`Method ${methodName} cannot replace schema with ${newType}`);
            }
            if (newType === null) {
                finalType = null;
                return false;
            }
            finalType = newType;
            return true;
        });
        return finalType;
    }
    function visit1(type118) {
        if (isSchema(type118)) {
            callMethod('visitSchema', type118);
            const typeMap = type118.getTypeMap();
            Object.entries(typeMap).forEach(([typeName, namedType])=>{
                if (!typeName.startsWith('__') && namedType != null) {
                    typeMap[typeName] = visit1(namedType);
                }
            });
            return type118;
        }
        if (isObjectType(type118)) {
            const newObject = callMethod('visitObject', type118);
            if (newObject != null) {
                visitFields(newObject);
            }
            return newObject;
        }
        if (isInterfaceType(type118)) {
            const newInterface = callMethod('visitInterface', type118);
            if (newInterface != null) {
                visitFields(newInterface);
            }
            return newInterface;
        }
        if (isInputObjectType(type118)) {
            const newInputObject = callMethod('visitInputObject', type118);
            if (newInputObject != null) {
                const fieldMap = newInputObject.getFields();
                for (const key of Object.keys(fieldMap)){
                    fieldMap[key] = callMethod('visitInputFieldDefinition', fieldMap[key], {
                        objectType: newInputObject
                    });
                    if (!fieldMap[key]) {
                        delete fieldMap[key];
                    }
                }
            }
            return newInputObject;
        }
        if (isScalarType(type118)) {
            return callMethod('visitScalar', type118);
        }
        if (isUnionType(type118)) {
            return callMethod('visitUnion', type118);
        }
        if (isEnumType(type118)) {
            let newEnum = callMethod('visitEnum', type118);
            if (newEnum != null) {
                const newValues = newEnum.getValues().map((value)=>callMethod('visitEnumValue', value, {
                        enumType: newEnum
                    })
                ).filter(Boolean);
                const valuesUpdated = newValues.some((value, index)=>value !== newEnum.getValues()[index]
                );
                if (valuesUpdated) {
                    newEnum = new GraphQLEnumType({
                        ...newEnum.toConfig(),
                        values: newValues.reduce((prev, value)=>({
                                ...prev,
                                [value.name]: {
                                    value: value.value,
                                    deprecationReason: value.deprecationReason,
                                    description: value.description,
                                    astNode: value.astNode
                                }
                            })
                        , {})
                    });
                }
            }
            return newEnum;
        }
        throw new Error(`Unexpected schema type: ${type118}`);
    }
    function visitFields(type119) {
        const fieldMap = type119.getFields();
        for (const [key, field] of Object.entries(fieldMap)){
            const newField = callMethod('visitFieldDefinition', field, {
                objectType: type119
            });
            if (newField.args != null) {
                newField.args = newField.args.map((arg)=>callMethod('visitArgumentDefinition', arg, {
                        field: newField,
                        objectType: type119
                    })
                ).filter(Boolean);
            }
            if (newField) {
                fieldMap[key] = newField;
            } else {
                delete fieldMap[key];
            }
        }
    }
    visit1(schema);
    healSchema(schema);
    return schema;
}
class SchemaDirectiveVisitor extends SchemaVisitor {
    name;
    args;
    visitedType;
    context;
    static getDirectiveDeclaration(directiveName, schema) {
        return schema.getDirective(directiveName);
    }
    static visitSchemaDirectives(schema, directiveVisitors, context = Object.create(null)) {
        const declaredDirectives = this.getDeclaredDirectives(schema, directiveVisitors);
        const createdVisitors = Object.keys(directiveVisitors).reduce((prev, item)=>({
                ...prev,
                [item]: []
            })
        , {});
        const directiveVisitorMap = Object.entries(directiveVisitors).reduce((prev, [key, value])=>({
                ...prev,
                [key]: value
            })
        , {});
        function visitorSelector(type120, methodName) {
            let directiveNodes = type120?.astNode?.directives ?? [];
            const extensionASTNodes = type120.extensionASTNodes;
            if (extensionASTNodes != null) {
                extensionASTNodes.forEach((extensionASTNode)=>{
                    if (extensionASTNode.directives != null) {
                        directiveNodes = directiveNodes.concat(extensionASTNode.directives);
                    }
                });
            }
            const visitors = [];
            directiveNodes.forEach((directiveNode)=>{
                const directiveName = directiveNode.name.value;
                if (!(directiveName in directiveVisitorMap)) {
                    return;
                }
                const VisitorClass = directiveVisitorMap[directiveName];
                if (!VisitorClass.implementsVisitorMethod(methodName)) {
                    return;
                }
                const decl = declaredDirectives[directiveName];
                let args;
                if (decl != null) {
                    args = getArgumentValues1(decl, directiveNode);
                } else {
                    args = Object.create(null);
                    if (directiveNode.arguments != null) {
                        directiveNode.arguments.forEach((arg)=>{
                            args[arg.name.value] = valueFromASTUntyped(arg.value);
                        });
                    }
                }
                visitors.push(new VisitorClass({
                    name: directiveName,
                    args,
                    visitedType: type120,
                    schema,
                    context
                }));
            });
            if (visitors.length > 0) {
                visitors.forEach((visitor)=>{
                    createdVisitors[visitor.name].push(visitor);
                });
            }
            return visitors;
        }
        visitSchema(schema, visitorSelector);
        return createdVisitors;
    }
    static getDeclaredDirectives(schema, directiveVisitors) {
        const declaredDirectives = schema.getDirectives().reduce((prev, curr)=>({
                ...prev,
                [curr.name]: curr
            })
        , {});
        Object.entries(directiveVisitors).forEach(([directiveName, visitorClass])=>{
            const decl = visitorClass.getDirectiveDeclaration(directiveName, schema);
            if (decl != null) {
                declaredDirectives[directiveName] = decl;
            }
        });
        Object.entries(declaredDirectives).forEach(([name, decl])=>{
            if (!(name in directiveVisitors)) {
                return;
            }
            const visitorClass = directiveVisitors[name];
            decl.locations.forEach((loc)=>{
                const visitorMethodName = directiveLocationToVisitorMethodName(loc);
                if (SchemaVisitor.implementsVisitorMethod(visitorMethodName) && !visitorClass.implementsVisitorMethod(visitorMethodName)) {
                    throw new Error(`SchemaDirectiveVisitor for @${name} must implement ${visitorMethodName} method`);
                }
            });
        });
        return declaredDirectives;
    }
    constructor(config){
        super();
        this.name = config.name;
        this.args = config.args;
        this.visitedType = config.visitedType;
        this.schema = config.schema;
        this.context = config.context;
    }
}
function getDirectives(schema, node) {
    const schemaDirectives = schema && schema.getDirectives ? schema.getDirectives() : [];
    const schemaDirectiveMap1 = schemaDirectives.reduce((schemaDirectiveMap, schemaDirective)=>{
        schemaDirectiveMap[schemaDirective.name] = schemaDirective;
        return schemaDirectiveMap;
    }, {});
    let astNodes = [];
    if (node.astNode) {
        astNodes.push(node.astNode);
    }
    if ('extensionASTNodes' in node && node.extensionASTNodes) {
        astNodes = [
            ...astNodes,
            ...node.extensionASTNodes
        ];
    }
    const result = {};
    astNodes.forEach((astNode)=>{
        if (astNode.directives) {
            astNode.directives.forEach((directive)=>{
                const schemaDirective = schemaDirectiveMap1[directive.name.value];
                if (schemaDirective) {
                    const directiveValue = getDirectiveValues1(schemaDirective, astNode);
                    if (schemaDirective.isRepeatable) {
                        if (result[schemaDirective.name]) {
                            result[schemaDirective.name] = result[schemaDirective.name].concat([
                                directiveValue
                            ]);
                        } else {
                            result[schemaDirective.name] = [
                                directiveValue
                            ];
                        }
                    } else {
                        result[schemaDirective.name] = directiveValue;
                    }
                }
            });
        }
    });
    return result;
}
function directiveLocationToVisitorMethodName(loc) {
    return 'visit' + loc.replace(/([^_]*)_?/g, (_wholeMatch, part)=>part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    );
}
function getTypeSpecifiers1(type121, schema) {
    const specifiers = [
        VisitSchemaKind.TYPE
    ];
    if (isObjectType(type121)) {
        specifiers.push(VisitSchemaKind.COMPOSITE_TYPE, VisitSchemaKind.OBJECT_TYPE);
        const query5 = schema.getQueryType();
        const mutation = schema.getMutationType();
        const subscription = schema.getSubscriptionType();
        if (type121 === query5) {
            specifiers.push(VisitSchemaKind.ROOT_OBJECT, VisitSchemaKind.QUERY);
        } else if (type121 === mutation) {
            specifiers.push(VisitSchemaKind.ROOT_OBJECT, VisitSchemaKind.MUTATION);
        } else if (type121 === subscription) {
            specifiers.push(VisitSchemaKind.ROOT_OBJECT, VisitSchemaKind.SUBSCRIPTION);
        }
    } else if (isInputType(type121)) {
        specifiers.push(VisitSchemaKind.INPUT_OBJECT_TYPE);
    } else if (isInterfaceType(type121)) {
        specifiers.push(VisitSchemaKind.COMPOSITE_TYPE, VisitSchemaKind.ABSTRACT_TYPE, VisitSchemaKind.INTERFACE_TYPE);
    } else if (isUnionType(type121)) {
        specifiers.push(VisitSchemaKind.COMPOSITE_TYPE, VisitSchemaKind.ABSTRACT_TYPE, VisitSchemaKind.UNION_TYPE);
    } else if (isEnumType(type121)) {
        specifiers.push(VisitSchemaKind.ENUM_TYPE);
    } else if (isScalarType(type121)) {
        specifiers.push(VisitSchemaKind.SCALAR_TYPE);
    }
    return specifiers;
}
function getVisitor(visitorDef, specifiers) {
    let typeVisitor;
    const stack = [
        ...specifiers
    ];
    while(!typeVisitor && stack.length > 0){
        const next = stack.pop();
        typeVisitor = next && visitorDef[next];
    }
    return typeVisitor != null ? typeVisitor : null;
}
function getDirectiveValues1(directiveDef, node) {
    if (node.directives) {
        if (directiveDef.isRepeatable) {
            const directiveNodes = node.directives.filter((directive)=>directive.name.value === directiveDef.name
            );
            return directiveNodes.map((directiveNode)=>getArgumentValues1(directiveDef, directiveNode)
            );
        }
        const directiveNode1 = node.directives.find((directive)=>directive.name.value === directiveDef.name
        );
        return getArgumentValues1(directiveDef, directiveNode1);
    }
}
function checkForResolveTypeResolver(schema, requireResolversForResolveType) {
    Object.keys(schema.getTypeMap()).map((typeName)=>schema.getType(typeName)
    ).forEach((type122)=>{
        if (!isAbstractType(type122)) return;
        if (!type122.resolveType) {
            if (!requireResolversForResolveType) {
                return;
            }
            throw new Error(`Type "${type122.name}" is missing a "__resolveType" resolver. Pass false into ` + '"resolverValidationOptions.requireResolversForResolveType" to disable this error.');
        }
    });
}
function extendResolversFromInterfaces(schema, resolvers1) {
    const typeNames = Object.keys({
        ...schema.getTypeMap(),
        ...resolvers1
    });
    const extendedResolvers = {};
    typeNames.forEach((typeName)=>{
        const type123 = schema.getType(typeName);
        if ('getInterfaces' in type123) {
            const allInterfaceResolvers = type123.getInterfaces().map((iFace)=>resolvers1[iFace.name]
            ).filter((interfaceResolvers)=>interfaceResolvers != null
            );
            extendedResolvers[typeName] = {};
            allInterfaceResolvers.forEach((interfaceResolvers)=>{
                Object.keys(interfaceResolvers).forEach((fieldName)=>{
                    if (fieldName === '__isTypeOf' || !fieldName.startsWith('__')) {
                        extendedResolvers[typeName][fieldName] = interfaceResolvers[fieldName];
                    }
                });
            });
            const typeResolvers = resolvers1[typeName];
            extendedResolvers[typeName] = {
                ...extendedResolvers[typeName],
                ...typeResolvers
            };
        } else {
            const typeResolvers = resolvers1[typeName];
            if (typeResolvers != null) {
                extendedResolvers[typeName] = typeResolvers;
            }
        }
    });
    return extendedResolvers;
}
function addResolversToSchema(schemaOrOptions, legacyInputResolvers, legacyInputValidationOptions) {
    const options = isSchema(schemaOrOptions) ? {
        schema: schemaOrOptions,
        resolvers: legacyInputResolvers,
        resolverValidationOptions: legacyInputValidationOptions
    } : schemaOrOptions;
    let { schema , resolvers: inputResolvers , defaultFieldResolver: defaultFieldResolver1 , resolverValidationOptions ={} , inheritResolversFromInterfaces =false , updateResolversInPlace =false  } = options;
    const { allowResolversNotInSchema =false , requireResolversForResolveType  } = resolverValidationOptions;
    const resolvers2 = inheritResolversFromInterfaces ? extendResolversFromInterfaces(schema, inputResolvers) : inputResolvers;
    Object.keys(resolvers2).forEach((typeName)=>{
        const resolverValue = resolvers2[typeName];
        const resolverType = typeof resolverValue;
        if (typeName === '__schema') {
            if (resolverType !== 'function') {
                throw new Error(`"${typeName}" defined in resolvers, but has invalid value "${resolverValue}". A schema resolver's value must be of type object or function.`);
            }
        } else {
            if (resolverType !== 'object') {
                throw new Error(`"${typeName}" defined in resolvers, but has invalid value "${resolverValue}". The resolver's value must be of type object.`);
            }
            const type124 = schema.getType(typeName);
            if (type124 == null) {
                if (allowResolversNotInSchema) {
                    return;
                }
                throw new Error(`"${typeName}" defined in resolvers, but not in schema`);
            } else if (isSpecifiedScalarType(type124)) {
                Object.keys(resolverValue).forEach((fieldName)=>{
                    if (fieldName.startsWith('__')) {
                        type124[fieldName.substring(2)] = resolverValue[fieldName];
                    } else {
                        type124[fieldName] = resolverValue[fieldName];
                    }
                });
            }
        }
    });
    schema = updateResolversInPlace ? addResolversToExistingSchema({
        schema,
        resolvers: resolvers2,
        defaultFieldResolver: defaultFieldResolver1,
        allowResolversNotInSchema
    }) : createNewSchemaWithResolvers({
        schema,
        resolvers: resolvers2,
        defaultFieldResolver: defaultFieldResolver1,
        allowResolversNotInSchema
    });
    checkForResolveTypeResolver(schema, requireResolversForResolveType);
    return schema;
}
function addResolversToExistingSchema({ schema , resolvers: resolvers3 , defaultFieldResolver: defaultFieldResolver2 , allowResolversNotInSchema  }) {
    const typeMap = schema.getTypeMap();
    Object.keys(resolvers3).forEach((typeName)=>{
        if (typeName !== '__schema') {
            const type125 = schema.getType(typeName);
            const resolverValue = resolvers3[typeName];
            if (isScalarType(type125)) {
                Object.keys(resolverValue).forEach((fieldName)=>{
                    if (fieldName.startsWith('__')) {
                        type125[fieldName.substring(2)] = resolverValue[fieldName];
                    } else {
                        type125[fieldName] = resolverValue[fieldName];
                    }
                });
            } else if (isEnumType(type125)) {
                const config = type125.toConfig();
                const enumValueConfigMap = config.values;
                Object.keys(resolverValue).forEach((fieldName)=>{
                    if (fieldName.startsWith('__')) {
                        config[fieldName.substring(2)] = resolverValue[fieldName];
                    } else if (!enumValueConfigMap[fieldName]) {
                        if (allowResolversNotInSchema) {
                            return;
                        }
                        throw new Error(`${type125.name}.${fieldName} was defined in resolvers, but not present within ${type125.name}`);
                    } else {
                        enumValueConfigMap[fieldName].value = resolverValue[fieldName];
                    }
                });
                typeMap[typeName] = new GraphQLEnumType(config);
            } else if (isUnionType(type125)) {
                Object.keys(resolverValue).forEach((fieldName)=>{
                    if (fieldName.startsWith('__')) {
                        type125[fieldName.substring(2)] = resolverValue[fieldName];
                        return;
                    }
                    if (allowResolversNotInSchema) {
                        return;
                    }
                    throw new Error(`${type125.name}.${fieldName} was defined in resolvers, but ${type125.name} is not an object or interface type`);
                });
            } else if (isObjectType(type125) || isInterfaceType(type125)) {
                Object.keys(resolverValue).forEach((fieldName)=>{
                    if (fieldName.startsWith('__')) {
                        type125[fieldName.substring(2)] = resolverValue[fieldName];
                        return;
                    }
                    const fields = type125.getFields();
                    const field = fields[fieldName];
                    if (field == null) {
                        if (allowResolversNotInSchema) {
                            return;
                        }
                        throw new Error(`${typeName}.${fieldName} defined in resolvers, but not in schema`);
                    }
                    const fieldResolve = resolverValue[fieldName];
                    if (typeof fieldResolve === 'function') {
                        field.resolve = fieldResolve;
                    } else {
                        if (typeof fieldResolve !== 'object') {
                            throw new Error(`Resolver ${typeName}.${fieldName} must be object or function`);
                        }
                        setFieldProperties(field, fieldResolve);
                    }
                });
            }
        }
    });
    forEachDefaultValue(schema, serializeInputValue);
    healSchema(schema);
    forEachDefaultValue(schema, parseInputValue);
    if (defaultFieldResolver2 != null) {
        forEachField(schema, (field)=>{
            if (!field.resolve) {
                field.resolve = defaultFieldResolver2;
            }
        });
    }
    return schema;
}
function createNewSchemaWithResolvers({ schema , resolvers: resolvers4 , defaultFieldResolver: defaultFieldResolver3 , allowResolversNotInSchema  }) {
    schema = mapSchema(schema, {
        [MapperKind.SCALAR_TYPE]: (type126)=>{
            const config = type126.toConfig();
            const resolverValue = resolvers4[type126.name];
            if (!isSpecifiedScalarType(type126) && resolverValue != null) {
                Object.keys(resolverValue).forEach((fieldName)=>{
                    if (fieldName.startsWith('__')) {
                        config[fieldName.substring(2)] = resolverValue[fieldName];
                    } else {
                        config[fieldName] = resolverValue[fieldName];
                    }
                });
                return new GraphQLScalarType(config);
            }
        },
        [MapperKind.ENUM_TYPE]: (type127)=>{
            const resolverValue = resolvers4[type127.name];
            const config = type127.toConfig();
            const enumValueConfigMap = config.values;
            if (resolverValue != null) {
                Object.keys(resolverValue).forEach((fieldName)=>{
                    if (fieldName.startsWith('__')) {
                        config[fieldName.substring(2)] = resolverValue[fieldName];
                    } else if (!enumValueConfigMap[fieldName]) {
                        if (allowResolversNotInSchema) {
                            return;
                        }
                        throw new Error(`${type127.name}.${fieldName} was defined in resolvers, but not present within ${type127.name}`);
                    } else {
                        enumValueConfigMap[fieldName].value = resolverValue[fieldName];
                    }
                });
                return new GraphQLEnumType(config);
            }
        },
        [MapperKind.UNION_TYPE]: (type128)=>{
            const resolverValue = resolvers4[type128.name];
            if (resolverValue != null) {
                const config = type128.toConfig();
                Object.keys(resolverValue).forEach((fieldName)=>{
                    if (fieldName.startsWith('__')) {
                        config[fieldName.substring(2)] = resolverValue[fieldName];
                        return;
                    }
                    if (allowResolversNotInSchema) {
                        return;
                    }
                    throw new Error(`${type128.name}.${fieldName} was defined in resolvers, but ${type128.name} is not an object or interface type`);
                });
                return new GraphQLUnionType(config);
            }
        },
        [MapperKind.OBJECT_TYPE]: (type129)=>{
            const resolverValue = resolvers4[type129.name];
            if (resolverValue != null) {
                const config = type129.toConfig();
                const fields = config.fields;
                Object.keys(resolverValue).forEach((fieldName)=>{
                    if (fieldName.startsWith('__')) {
                        config[fieldName.substring(2)] = resolverValue[fieldName];
                        return;
                    }
                    const field = fields[fieldName];
                    if (field == null) {
                        if (allowResolversNotInSchema) {
                            return;
                        }
                        throw new Error(`${type129.name}.${fieldName} defined in resolvers, but not in schema`);
                    }
                });
                return new GraphQLObjectType(config);
            }
        },
        [MapperKind.INTERFACE_TYPE]: (type130)=>{
            const resolverValue = resolvers4[type130.name];
            if (resolverValue != null) {
                const config = type130.toConfig();
                const fields = config.fields;
                Object.keys(resolverValue).forEach((fieldName)=>{
                    if (fieldName.startsWith('__')) {
                        config[fieldName.substring(2)] = resolverValue[fieldName];
                        return;
                    }
                    const field = fields[fieldName];
                    if (field == null) {
                        if (allowResolversNotInSchema) {
                            return;
                        }
                        throw new Error(`${type130.name}.${fieldName} defined in resolvers, but not in schema`);
                    }
                });
                return new GraphQLInterfaceType(config);
            }
        },
        [MapperKind.COMPOSITE_FIELD]: (fieldConfig, fieldName, typeName)=>{
            const resolverValue = resolvers4[typeName];
            if (resolverValue != null) {
                const fieldResolve = resolverValue[fieldName];
                if (fieldResolve != null) {
                    const newFieldConfig = {
                        ...fieldConfig
                    };
                    if (typeof fieldResolve === 'function') {
                        newFieldConfig.resolve = fieldResolve;
                    } else {
                        if (typeof fieldResolve !== 'object') {
                            throw new Error(`Resolver ${typeName}.${fieldName} must be object or function`);
                        }
                        setFieldProperties(newFieldConfig, fieldResolve);
                    }
                    return newFieldConfig;
                }
            }
        }
    });
    if (defaultFieldResolver3 != null) {
        schema = mapSchema(schema, {
            [MapperKind.OBJECT_FIELD]: (fieldConfig)=>({
                    ...fieldConfig,
                    resolve: fieldConfig.resolve != null ? fieldConfig.resolve : defaultFieldResolver3
                })
        });
    }
    return schema;
}
function setFieldProperties(field, propertiesObj) {
    Object.keys(propertiesObj).forEach((propertyName)=>{
        field[propertyName] = propertiesObj[propertyName];
    });
}
function attachDirectiveResolvers(schema, directiveResolvers) {
    if (typeof directiveResolvers !== 'object') {
        throw new Error(`Expected directiveResolvers to be of type object, got ${typeof directiveResolvers}`);
    }
    if (Array.isArray(directiveResolvers)) {
        throw new Error('Expected directiveResolvers to be of type object, got Array');
    }
    return mapSchema(schema, {
        [MapperKind.OBJECT_FIELD]: (fieldConfig)=>{
            const newFieldConfig = {
                ...fieldConfig
            };
            const directives = getDirectives(schema, fieldConfig);
            Object.keys(directives).forEach((directiveName)=>{
                if (directiveResolvers[directiveName]) {
                    const resolver = directiveResolvers[directiveName];
                    const originalResolver = newFieldConfig.resolve != null ? newFieldConfig.resolve : defaultFieldResolver;
                    const directiveArgs = directives[directiveName];
                    newFieldConfig.resolve = (source, originalArgs, context, info)=>{
                        return resolver(()=>new Promise((resolve, reject2)=>{
                                const result = originalResolver(source, originalArgs, context, info);
                                if (result instanceof Error) {
                                    reject2(result);
                                }
                                resolve(result);
                            })
                        , source, directiveArgs, context, info);
                    };
                }
            });
            return newFieldConfig;
        }
    });
}
function assertResolversPresent(schema, resolverValidationOptions = {}) {
    const { requireResolversForArgs =false , requireResolversForNonScalar =false , requireResolversForAllFields =false  } = resolverValidationOptions;
    if (requireResolversForAllFields && (requireResolversForArgs || requireResolversForNonScalar)) {
        throw new TypeError('requireResolversForAllFields takes precedence over the more specific assertions. ' + 'Please configure either requireResolversForAllFields or requireResolversForArgs / ' + 'requireResolversForNonScalar, but not a combination of them.');
    }
    forEachField(schema, (field, typeName, fieldName)=>{
        if (requireResolversForAllFields) {
            expectResolver(field, typeName, fieldName);
        }
        if (requireResolversForArgs && field.args.length > 0) {
            expectResolver(field, typeName, fieldName);
        }
        if (requireResolversForNonScalar && !isScalarType(getNamedType(field.type))) {
            expectResolver(field, typeName, fieldName);
        }
    });
}
function expectResolver(field, typeName, fieldName) {
    if (!field.resolve) {
        console.warn(`Resolver missing for "${typeName}.${fieldName}".
To disable this warning check pass;
resolverValidationOptions: {
  requireResolversForNonScalar: false
}
      `);
        return;
    }
    if (typeof field.resolve !== 'function') {
        throw new Error(`Resolver "${typeName}.${fieldName}" must be a function`);
    }
}
function addSchemaLevelResolver(schema1, fn) {
    const fnToRunOnlyOnce = runAtMostOncePerRequest(fn);
    return mapSchema(schema1, {
        [MapperKind.ROOT_FIELD]: (fieldConfig, _fieldName, typeName, schema)=>{
            const subscription = schema.getSubscriptionType();
            if (subscription != null && subscription.name === typeName) {
                return {
                    ...fieldConfig,
                    resolve: wrapResolver(fieldConfig.resolve, fn)
                };
            }
            return {
                ...fieldConfig,
                resolve: wrapResolver(fieldConfig.resolve, fnToRunOnlyOnce)
            };
        }
    });
}
function wrapResolver(innerResolver, outerResolver) {
    return (obj, args, ctx, info)=>resolveMaybePromise(outerResolver(obj, args, ctx, info), (root)=>{
            if (innerResolver != null) {
                return innerResolver(root, args, ctx, info);
            }
            return defaultFieldResolver(root, args, ctx, info);
        })
    ;
}
function isPromise1(maybePromise) {
    return maybePromise && typeof maybePromise.then === 'function';
}
function resolveMaybePromise(maybePromise, fulfillmentCallback) {
    if (isPromise1(maybePromise)) {
        return maybePromise.then(fulfillmentCallback);
    }
    return fulfillmentCallback(maybePromise);
}
function runAtMostOncePerRequest(fn) {
    let value;
    const randomNumber = Math.random();
    return (root, args, ctx, info)=>{
        if (!info.operation['__runAtMostOnce']) {
            info.operation['__runAtMostOnce'] = {};
        }
        if (!info.operation['__runAtMostOnce'][randomNumber]) {
            info.operation['__runAtMostOnce'][randomNumber] = true;
            value = fn(root, args, ctx, info);
        }
        return value;
    };
}
function extractExtensionDefinitions(ast) {
    const extensionDefs = ast.definitions.filter((def)=>def.kind === Kind.OBJECT_TYPE_EXTENSION || def.kind === Kind.INTERFACE_TYPE_EXTENSION || def.kind === Kind.INPUT_OBJECT_TYPE_EXTENSION || def.kind === Kind.UNION_TYPE_EXTENSION || def.kind === Kind.ENUM_TYPE_EXTENSION || def.kind === Kind.SCALAR_TYPE_EXTENSION || def.kind === Kind.SCHEMA_EXTENSION
    );
    return {
        ...ast,
        definitions: extensionDefs
    };
}
function filterExtensionDefinitions(ast) {
    const extensionDefs = ast.definitions.filter((def)=>def.kind !== Kind.OBJECT_TYPE_EXTENSION && def.kind !== Kind.INTERFACE_TYPE_EXTENSION && def.kind !== Kind.INPUT_OBJECT_TYPE_EXTENSION && def.kind !== Kind.UNION_TYPE_EXTENSION && def.kind !== Kind.ENUM_TYPE_EXTENSION && def.kind !== Kind.SCALAR_TYPE_EXTENSION && def.kind !== Kind.SCHEMA_EXTENSION
    );
    return {
        ...ast,
        definitions: extensionDefs
    };
}
function concatenateTypeDefs(typeDefinitionsAry, calledFunctionRefs = []) {
    let resolvedTypeDefinitions = [];
    typeDefinitionsAry.forEach((typeDef)=>{
        if (typeof typeDef === 'function') {
            if (calledFunctionRefs.indexOf(typeDef) === -1) {
                calledFunctionRefs.push(typeDef);
                resolvedTypeDefinitions = resolvedTypeDefinitions.concat(concatenateTypeDefs(typeDef(), calledFunctionRefs));
            }
        } else if (typeof typeDef === 'string') {
            resolvedTypeDefinitions.push(typeDef.trim());
        } else if (typeDef.kind !== undefined) {
            resolvedTypeDefinitions.push(print(typeDef).trim());
        } else {
            const type131 = typeof typeDef;
            throw new Error(`typeDef array must contain only strings, documents, or functions, got ${type131}`);
        }
    });
    return uniq(resolvedTypeDefinitions.map((x)=>x.trim()
    )).join('\n');
}
function uniq(array) {
    return array.reduce((accumulator, currentValue)=>accumulator.indexOf(currentValue) === -1 ? [
            ...accumulator,
            currentValue
        ] : accumulator
    , []);
}
function buildSchemaFromTypeDefinitions(typeDefinitions, parseOptions) {
    const document = buildDocumentFromTypeDefinitions(typeDefinitions, parseOptions);
    const typesAst = filterExtensionDefinitions(document);
    const backcompatOptions = {
        commentDescriptions: true
    };
    let schema = buildASTSchema(typesAst, backcompatOptions);
    const extensionsAst = extractExtensionDefinitions(document);
    if (extensionsAst.definitions.length > 0) {
        schema = extendSchema(schema, extensionsAst, backcompatOptions);
    }
    return schema;
}
function isDocumentNode(typeDefinitions) {
    return typeDefinitions.kind !== undefined;
}
function buildDocumentFromTypeDefinitions(typeDefinitions, parseOptions) {
    let document;
    if (typeof typeDefinitions === 'string') {
        document = parse1(typeDefinitions, parseOptions);
    } else if (Array.isArray(typeDefinitions)) {
        document = parse1(concatenateTypeDefs(typeDefinitions), parseOptions);
    } else if (isDocumentNode(typeDefinitions)) {
        document = typeDefinitions;
    } else {
        const type132 = typeof typeDefinitions;
        throw new Error(`typeDefs must be a string, array or schema AST, got ${type132}`);
    }
    return document;
}
function decorateWithLogger(fn, logger, hint) {
    const resolver = fn != null ? fn : defaultFieldResolver;
    const logError = (e)=>{
        const newE = new Error();
        newE.stack = e.stack;
        if (hint) {
            newE['originalMessage'] = e.message;
            newE.message = `Error in resolver ${hint}\n${e.message}`;
        }
        logger.log(newE);
    };
    return (root, args, ctx, info)=>{
        try {
            const result = resolver(root, args, ctx, info);
            if (result && typeof result.then === 'function' && typeof result.catch === 'function') {
                result.catch((reason)=>{
                    const error = reason instanceof Error ? reason : new Error(reason);
                    logError(error);
                    return reason;
                });
            }
            return result;
        } catch (e) {
            logError(e);
            throw e;
        }
    };
}
function addErrorLoggingToSchema(schema, logger) {
    if (!logger) {
        throw new Error('Must provide a logger');
    }
    if (typeof logger.log !== 'function') {
        throw new Error('Logger.log must be a function');
    }
    return mapSchema(schema, {
        [MapperKind.OBJECT_FIELD]: (fieldConfig, fieldName, typeName)=>({
                ...fieldConfig,
                resolve: decorateWithLogger(fieldConfig.resolve, logger, `${typeName}.${fieldName}`)
            })
    });
}
function decorateToCatchUndefined(fn, hint) {
    const resolve = fn == null ? defaultFieldResolver : fn;
    return (root, args, ctx, info)=>{
        const result = resolve(root, args, ctx, info);
        if (typeof result === 'undefined') {
            throw new Error(`Resolver for "${hint}" returned undefined`);
        }
        return result;
    };
}
function addCatchUndefinedToSchema(schema) {
    return mapSchema(schema, {
        [MapperKind.OBJECT_FIELD]: (fieldConfig, fieldName, typeName)=>({
                ...fieldConfig,
                resolve: decorateToCatchUndefined(fieldConfig.resolve, `${typeName}.${fieldName}`)
            })
    });
}
function makeExecutableSchema({ typeDefs: typeDefs2 , resolvers: resolvers5 = {} , logger , allowUndefinedInResolve =true , resolverValidationOptions ={} , directiveResolvers , schemaDirectives , schemaTransforms =[] , parseOptions ={} , inheritResolversFromInterfaces =false  }) {
    if (typeof resolverValidationOptions !== 'object') {
        throw new Error('Expected `resolverValidationOptions` to be an object');
    }
    if (!typeDefs2) {
        throw new Error('Must provide typeDefs');
    }
    const resolverMap = Array.isArray(resolvers5) ? resolvers5.reduce(mergeDeep, {}) : resolvers5;
    let schema = buildSchemaFromTypeDefinitions(typeDefs2, parseOptions);
    schema = addResolversToSchema({
        schema,
        resolvers: resolverMap,
        resolverValidationOptions,
        inheritResolversFromInterfaces
    });
    assertResolversPresent(schema, resolverValidationOptions);
    if (!allowUndefinedInResolve) {
        schema = addCatchUndefinedToSchema(schema);
    }
    if (logger != null) {
        schema = addErrorLoggingToSchema(schema, logger);
    }
    if (typeof resolvers5['__schema'] === 'function') {
        schema = addSchemaLevelResolver(schema, resolvers5['__schema']);
    }
    schemaTransforms.forEach((schemaTransform)=>{
        schema = schemaTransform(schema);
    });
    if (directiveResolvers != null) {
        schema = attachDirectiveResolvers(schema, directiveResolvers);
    }
    if (schemaDirectives != null) {
        SchemaDirectiveVisitor.visitSchemaDirectives(schema, schemaDirectives);
    }
    return schema;
}
const docCache = new Map();
const fragmentSourceMap = new Map();
let printFragmentWarnings = true;
let experimentalFragmentVariables = false;
function normalize(string) {
    return string.replace(/[\s,]+/g, ' ').trim();
}
function cacheKeyFromLoc(loc) {
    return normalize(loc.source.body.substring(loc.start, loc.end));
}
function processFragments(ast) {
    const seenKeys = new Set();
    const definitions = [];
    ast.definitions.forEach((fragmentDefinition)=>{
        if (fragmentDefinition.kind === 'FragmentDefinition') {
            const fragmentName = fragmentDefinition.name.value;
            const sourceKey = cacheKeyFromLoc(fragmentDefinition.loc);
            let sourceKeySet = fragmentSourceMap.get(fragmentName);
            if (sourceKeySet && !sourceKeySet.has(sourceKey)) {
                if (printFragmentWarnings) {
                    console.warn('Warning: fragment with name ' + fragmentName + ' already exists.\n' + 'graphql-tag enforces all fragment names across your application to be unique; read more about\n' + 'this in the docs: http://dev.apollodata.com/core/fragments.html#unique-names');
                }
            } else if (!sourceKeySet) {
                fragmentSourceMap.set(fragmentName, sourceKeySet = new Set());
            }
            sourceKeySet.add(sourceKey);
            if (!seenKeys.has(sourceKey)) {
                seenKeys.add(sourceKey);
                definitions.push(fragmentDefinition);
            }
        } else {
            definitions.push(fragmentDefinition);
        }
    });
    return {
        ...ast,
        definitions
    };
}
function stripLoc(doc) {
    const workSet = new Set(doc.definitions);
    workSet.forEach((node)=>{
        if (node.loc) delete node.loc;
        Object.keys(node).forEach((key)=>{
            const value = node[key];
            if (value && typeof value === 'object') {
                workSet.add(value);
            }
        });
    });
    const loc = doc.loc;
    if (loc) {
        delete loc.startToken;
        delete loc.endToken;
    }
    return doc;
}
function parseDocument(source) {
    var cacheKey = normalize(source);
    if (!docCache.has(cacheKey)) {
        const parsed = parse1(source, {
            experimentalFragmentVariables
        });
        if (!parsed || parsed.kind !== 'Document') {
            throw new Error('Not a valid GraphQL document.');
        }
        docCache.set(cacheKey, stripLoc(processFragments(parsed)));
    }
    return docCache.get(cacheKey);
}
function gql(literals, ...args) {
    if (typeof literals === 'string') {
        literals = [
            literals
        ];
    }
    let result = literals[0];
    args.forEach((arg, i)=>{
        if (arg && arg.kind === 'Document') {
            result += arg.loc.source.body;
        } else {
            result += arg;
        }
        result += literals[i + 1];
    });
    return parseDocument(result);
}
var SortOptions;
(function(SortOptions1) {
    SortOptions1["DESC"] = "DESC";
    SortOptions1["ASC"] = "ASC";
})(SortOptions || (SortOptions = {}));
var Method;
(function(Method1) {
    Method1["GET"] = "GET";
    Method1["POST"] = "POST";
    Method1["PUT"] = "PUT";
    Method1["DELETE"] = "DELETE";
    Method1["PATCH"] = "PATCH";
})(Method || (Method = {}));
var Action;
(function(Action1) {
    Action1["QUERY"] = "_query";
    Action1["BULK"] = "_bulk";
    Action1["INDEX"] = "_index";
})(Action || (Action = {}));
const service = "data";
const add = (body)=>(hyper2)=>hyper2({
            service,
            method: Method.POST,
            body
        })
;
const get = (id)=>(hyper3)=>hyper3({
            service,
            method: Method.GET,
            resource: id
        })
;
const list = (options = {})=>(hyper4)=>hyper4({
            service,
            method: Method.GET,
            params: options
        })
;
const update = (id, doc)=>(hyper5)=>hyper5({
            service,
            method: Method.PUT,
            resource: id,
            body: doc
        })
;
const remove = (id)=>(hyper6)=>hyper6({
            service,
            method: Method.DELETE,
            resource: id
        })
;
const query = (selector, options)=>(hyper7)=>hyper7({
            service,
            method: Method.POST,
            action: Action.QUERY,
            body: {
                selector,
                ...options
            }
        })
;
const bulk = (docs)=>(hyper8)=>hyper8({
            service,
            method: Method.POST,
            action: Action.BULK,
            body: docs
        })
;
const index = (indexName, fields)=>(hyper9)=>hyper9({
            service,
            method: Method.POST,
            action: Action.INDEX,
            body: {
                fields,
                name: indexName,
                type: "JSON"
            }
        })
;
const create = ()=>(hyper10)=>hyper10({
            service,
            method: Method.PUT
        })
;
const destroy = (confirm = true)=>(hyper11)=>confirm ? hyper11({
            service,
            method: Method.DELETE
        }) : Promise.reject({
            ok: false,
            msg: "request not confirmed!"
        })
;
const service1 = "cache";
const includeTTL = (ttl)=>(o2)=>ttl ? {
            ...o2,
            params: {
                ttl
            }
        } : o2
;
const add1 = (key, value, ttl)=>(h)=>h({
            service: service1,
            method: Method.POST,
            body: {
                key,
                value,
                ttl
            }
        })
;
const get1 = (key)=>(h)=>h({
            service: service1,
            method: Method.GET,
            resource: key
        })
;
const remove1 = (key)=>(h)=>h({
            service: service1,
            method: Method.DELETE,
            resource: key
        })
;
const set = (key, value, ttl)=>(h)=>h([
            {
                service: service1,
                method: Method.PUT,
                resource: key,
                body: value
            }
        ].map(includeTTL(ttl))[0])
;
const query1 = (pattern = "*")=>(h)=>h({
            service: service1,
            method: Method.POST,
            action: Action.QUERY,
            params: {
                pattern
            }
        })
;
const create1 = ()=>(hyper12)=>hyper12({
            service: service1,
            method: Method.PUT
        })
;
const destroy1 = (confirm = true)=>(hyper13)=>confirm ? hyper13({
            service: service1,
            method: Method.DELETE
        }) : Promise.reject({
            ok: false,
            msg: "request not confirmed!"
        })
;
var F = function() {
    return false;
};
var T = function() {
    return true;
};
var __ = {
    "@@functional/placeholder": true
};
function _isPlaceholder(a) {
    return a != null && typeof a === "object" && a["@@functional/placeholder"] === true;
}
function _curry1(fn) {
    return function f1(a) {
        if (arguments.length === 0 || _isPlaceholder(a)) {
            return f1;
        } else {
            return fn.apply(this, arguments);
        }
    };
}
function _curry2(fn) {
    return function f2(a, b) {
        switch(arguments.length){
            case 0:
                return f2;
            case 1:
                return _isPlaceholder(a) ? f2 : _curry1(function(_b) {
                    return fn(a, _b);
                });
            default:
                return _isPlaceholder(a) && _isPlaceholder(b) ? f2 : _isPlaceholder(a) ? _curry1(function(_a) {
                    return fn(_a, b);
                }) : _isPlaceholder(b) ? _curry1(function(_b) {
                    return fn(a, _b);
                }) : fn(a, b);
        }
    };
}
var add2 = _curry2(function add2(a, b) {
    return Number(a) + Number(b);
});
function _concat(set1, set22) {
    set1 = set1 || [];
    set22 = set22 || [];
    var idx;
    var len1 = set1.length;
    var len2 = set22.length;
    var result = [];
    idx = 0;
    while(idx < len1){
        result[result.length] = set1[idx];
        idx += 1;
    }
    idx = 0;
    while(idx < len2){
        result[result.length] = set22[idx];
        idx += 1;
    }
    return result;
}
function _arity(n, fn) {
    switch(n){
        case 0:
            return function() {
                return fn.apply(this, arguments);
            };
        case 1:
            return function(a0) {
                return fn.apply(this, arguments);
            };
        case 2:
            return function(a0, a1) {
                return fn.apply(this, arguments);
            };
        case 3:
            return function(a0, a1, a2) {
                return fn.apply(this, arguments);
            };
        case 4:
            return function(a0, a1, a2, a3) {
                return fn.apply(this, arguments);
            };
        case 5:
            return function(a0, a1, a2, a3, a4) {
                return fn.apply(this, arguments);
            };
        case 6:
            return function(a0, a1, a2, a3, a4, a5) {
                return fn.apply(this, arguments);
            };
        case 7:
            return function(a0, a1, a2, a3, a4, a5, a6) {
                return fn.apply(this, arguments);
            };
        case 8:
            return function(a0, a1, a2, a3, a4, a5, a6, a7) {
                return fn.apply(this, arguments);
            };
        case 9:
            return function(a0, a1, a2, a3, a4, a5, a6, a7, a8) {
                return fn.apply(this, arguments);
            };
        case 10:
            return function(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
                return fn.apply(this, arguments);
            };
        default:
            throw new Error("First argument to _arity must be a non-negative integer no greater than ten");
    }
}
function _curryN(length3, received, fn) {
    return function() {
        var combined = [];
        var argsIdx = 0;
        var left = length3;
        var combinedIdx = 0;
        while(combinedIdx < received.length || argsIdx < arguments.length){
            var result;
            if (combinedIdx < received.length && (!_isPlaceholder(received[combinedIdx]) || argsIdx >= arguments.length)) {
                result = received[combinedIdx];
            } else {
                result = arguments[argsIdx];
                argsIdx += 1;
            }
            combined[combinedIdx] = result;
            if (!_isPlaceholder(result)) {
                left -= 1;
            }
            combinedIdx += 1;
        }
        return left <= 0 ? fn.apply(this, combined) : _arity(left, _curryN(length3, combined, fn));
    };
}
var curryN = _curry2(function curryN2(length3, fn) {
    if (length3 === 1) {
        return _curry1(fn);
    }
    return _arity(length3, _curryN(length3, [], fn));
});
var addIndex = _curry1(function addIndex2(fn) {
    return curryN(fn.length, function() {
        var idx = 0;
        var origFn = arguments[0];
        var list9 = arguments[arguments.length - 1];
        var args = Array.prototype.slice.call(arguments, 0);
        args[0] = function() {
            var result = origFn.apply(this, _concat(arguments, [
                idx,
                list9
            ]));
            idx += 1;
            return result;
        };
        return fn.apply(this, args);
    });
});
function _curry3(fn) {
    return function f3(a, b, c) {
        switch(arguments.length){
            case 0:
                return f3;
            case 1:
                return _isPlaceholder(a) ? f3 : _curry2(function(_b, _c) {
                    return fn(a, _b, _c);
                });
            case 2:
                return _isPlaceholder(a) && _isPlaceholder(b) ? f3 : _isPlaceholder(a) ? _curry2(function(_a, _c) {
                    return fn(_a, b, _c);
                }) : _isPlaceholder(b) ? _curry2(function(_b, _c) {
                    return fn(a, _b, _c);
                }) : _curry1(function(_c) {
                    return fn(a, b, _c);
                });
            default:
                return _isPlaceholder(a) && _isPlaceholder(b) && _isPlaceholder(c) ? f3 : _isPlaceholder(a) && _isPlaceholder(b) ? _curry2(function(_a, _b) {
                    return fn(_a, _b, c);
                }) : _isPlaceholder(a) && _isPlaceholder(c) ? _curry2(function(_a, _c) {
                    return fn(_a, b, _c);
                }) : _isPlaceholder(b) && _isPlaceholder(c) ? _curry2(function(_b, _c) {
                    return fn(a, _b, _c);
                }) : _isPlaceholder(a) ? _curry1(function(_a) {
                    return fn(_a, b, c);
                }) : _isPlaceholder(b) ? _curry1(function(_b) {
                    return fn(a, _b, c);
                }) : _isPlaceholder(c) ? _curry1(function(_c) {
                    return fn(a, b, _c);
                }) : fn(a, b, c);
        }
    };
}
var adjust = _curry3(function adjust2(idx, fn, list10) {
    if (idx >= list10.length || idx < -list10.length) {
        return list10;
    }
    var start = idx < 0 ? list10.length : 0;
    var _idx = start + idx;
    var _list = _concat(list10);
    _list[_idx] = fn(list10[_idx]);
    return _list;
});
var _isArray = Array.isArray || function _isArray2(val) {
    return val != null && val.length >= 0 && Object.prototype.toString.call(val) === "[object Array]";
};
function _isTransformer(obj) {
    return obj != null && typeof obj["@@transducer/step"] === "function";
}
function _dispatchable(methodNames, xf, fn) {
    return function() {
        if (arguments.length === 0) {
            return fn();
        }
        var args = Array.prototype.slice.call(arguments, 0);
        var obj = args.pop();
        if (!_isArray(obj)) {
            var idx = 0;
            while(idx < methodNames.length){
                if (typeof obj[methodNames[idx]] === "function") {
                    return obj[methodNames[idx]].apply(obj, args);
                }
                idx += 1;
            }
            if (_isTransformer(obj)) {
                var transducer = xf.apply(null, args);
                return transducer(obj);
            }
        }
        return fn.apply(this, arguments);
    };
}
function _reduced(x) {
    return x && x["@@transducer/reduced"] ? x : {
        "@@transducer/value": x,
        "@@transducer/reduced": true
    };
}
var _xfBase = {
    init: function() {
        return this.xf["@@transducer/init"]();
    },
    result: function(result) {
        return this.xf["@@transducer/result"](result);
    }
};
var XAll = function() {
    function XAll2(f, xf) {
        this.xf = xf;
        this.f = f;
        this.all = true;
    }
    XAll2.prototype["@@transducer/init"] = _xfBase.init;
    XAll2.prototype["@@transducer/result"] = function(result) {
        if (this.all) {
            result = this.xf["@@transducer/step"](result, true);
        }
        return this.xf["@@transducer/result"](result);
    };
    XAll2.prototype["@@transducer/step"] = function(result, input) {
        if (!this.f(input)) {
            this.all = false;
            result = _reduced(this.xf["@@transducer/step"](result, false));
        }
        return result;
    };
    return XAll2;
}();
var _xall = _curry2(function _xall2(f, xf) {
    return new XAll(f, xf);
});
var all = _curry2(_dispatchable([
    "all"
], _xall, function all2(fn, list11) {
    var idx = 0;
    while(idx < list11.length){
        if (!fn(list11[idx])) {
            return false;
        }
        idx += 1;
    }
    return true;
}));
var max = _curry2(function max2(a, b) {
    return b > a ? b : a;
});
function _map(fn, functor) {
    var idx = 0;
    var len = functor.length;
    var result = Array(len);
    while(idx < len){
        result[idx] = fn(functor[idx]);
        idx += 1;
    }
    return result;
}
function _isString(x) {
    return Object.prototype.toString.call(x) === "[object String]";
}
var _isArrayLike = _curry1(function isArrayLike(x) {
    if (_isArray(x)) {
        return true;
    }
    if (!x) {
        return false;
    }
    if (typeof x !== "object") {
        return false;
    }
    if (_isString(x)) {
        return false;
    }
    if (x.nodeType === 1) {
        return !!x.length;
    }
    if (x.length === 0) {
        return true;
    }
    if (x.length > 0) {
        return x.hasOwnProperty(0) && x.hasOwnProperty(x.length - 1);
    }
    return false;
});
var XWrap = function() {
    function XWrap2(fn) {
        this.f = fn;
    }
    XWrap2.prototype["@@transducer/init"] = function() {
        throw new Error("init not implemented on XWrap");
    };
    XWrap2.prototype["@@transducer/result"] = function(acc) {
        return acc;
    };
    XWrap2.prototype["@@transducer/step"] = function(acc, x) {
        return this.f(acc, x);
    };
    return XWrap2;
}();
function _xwrap(fn) {
    return new XWrap(fn);
}
var bind = _curry2(function bind2(fn, thisObj) {
    return _arity(fn.length, function() {
        return fn.apply(thisObj, arguments);
    });
});
function _arrayReduce(xf, acc, list12) {
    var idx = 0;
    var len = list12.length;
    while(idx < len){
        acc = xf["@@transducer/step"](acc, list12[idx]);
        if (acc && acc["@@transducer/reduced"]) {
            acc = acc["@@transducer/value"];
            break;
        }
        idx += 1;
    }
    return xf["@@transducer/result"](acc);
}
function _iterableReduce(xf, acc, iter) {
    var step = iter.next();
    while(!step.done){
        acc = xf["@@transducer/step"](acc, step.value);
        if (acc && acc["@@transducer/reduced"]) {
            acc = acc["@@transducer/value"];
            break;
        }
        step = iter.next();
    }
    return xf["@@transducer/result"](acc);
}
function _methodReduce(xf, acc, obj, methodName) {
    return xf["@@transducer/result"](obj[methodName](bind(xf["@@transducer/step"], xf), acc));
}
var symIterator = typeof Symbol !== "undefined" ? Symbol.iterator : "@@iterator";
function _reduce(fn, acc, list13) {
    if (typeof fn === "function") {
        fn = _xwrap(fn);
    }
    if (_isArrayLike(list13)) {
        return _arrayReduce(fn, acc, list13);
    }
    if (typeof list13["fantasy-land/reduce"] === "function") {
        return _methodReduce(fn, acc, list13, "fantasy-land/reduce");
    }
    if (list13[symIterator] != null) {
        return _iterableReduce(fn, acc, list13[symIterator]());
    }
    if (typeof list13.next === "function") {
        return _iterableReduce(fn, acc, list13);
    }
    if (typeof list13.reduce === "function") {
        return _methodReduce(fn, acc, list13, "reduce");
    }
    throw new TypeError("reduce: list must be array or iterable");
}
var XMap = function() {
    function XMap2(f, xf) {
        this.xf = xf;
        this.f = f;
    }
    XMap2.prototype["@@transducer/init"] = _xfBase.init;
    XMap2.prototype["@@transducer/result"] = _xfBase.result;
    XMap2.prototype["@@transducer/step"] = function(result, input) {
        return this.xf["@@transducer/step"](result, this.f(input));
    };
    return XMap2;
}();
var _xmap = _curry2(function _xmap2(f, xf) {
    return new XMap(f, xf);
});
function _has(prop3, obj) {
    return Object.prototype.hasOwnProperty.call(obj, prop3);
}
var toString = Object.prototype.toString;
var _isArguments = function() {
    return toString.call(arguments) === "[object Arguments]" ? function _isArguments2(x) {
        return toString.call(x) === "[object Arguments]";
    } : function _isArguments2(x) {
        return _has("callee", x);
    };
}();
var hasEnumBug = !({
    toString: null
}).propertyIsEnumerable("toString");
var nonEnumerableProps = [
    "constructor",
    "valueOf",
    "isPrototypeOf",
    "toString",
    "propertyIsEnumerable",
    "hasOwnProperty",
    "toLocaleString"
];
var hasArgsEnumBug = function() {
    return arguments.propertyIsEnumerable("length");
}();
var contains = function contains2(list14, item) {
    var idx = 0;
    while(idx < list14.length){
        if (list14[idx] === item) {
            return true;
        }
        idx += 1;
    }
    return false;
};
var keys = typeof Object.keys === "function" && !hasArgsEnumBug ? _curry1(function keys2(obj) {
    return Object(obj) !== obj ? [] : Object.keys(obj);
}) : _curry1(function keys3(obj) {
    if (Object(obj) !== obj) {
        return [];
    }
    var prop3, nIdx;
    var ks = [];
    var checkArgsLength = hasArgsEnumBug && _isArguments(obj);
    for(prop3 in obj){
        if (_has(prop3, obj) && (!checkArgsLength || prop3 !== "length")) {
            ks[ks.length] = prop3;
        }
    }
    if (hasEnumBug) {
        nIdx = nonEnumerableProps.length - 1;
        while(nIdx >= 0){
            prop3 = nonEnumerableProps[nIdx];
            if (_has(prop3, obj) && !contains(ks, prop3)) {
                ks[ks.length] = prop3;
            }
            nIdx -= 1;
        }
    }
    return ks;
});
var map = _curry2(_dispatchable([
    "fantasy-land/map",
    "map"
], _xmap, function map2(fn, functor) {
    switch(Object.prototype.toString.call(functor)){
        case "[object Function]":
            return curryN(functor.length, function() {
                return fn.call(this, functor.apply(this, arguments));
            });
        case "[object Object]":
            return _reduce(function(acc, key) {
                acc[key] = fn(functor[key]);
                return acc;
            }, {}, keys(functor));
        default:
            return _map(fn, functor);
    }
}));
var _isInteger = Number.isInteger || function _isInteger2(n) {
    return n << 0 === n;
};
var nth = _curry2(function nth2(offset, list15) {
    var idx = offset < 0 ? list15.length + offset : offset;
    return _isString(list15) ? list15.charAt(idx) : list15[idx];
});
var paths = _curry2(function paths2(pathsArray, obj) {
    return pathsArray.map(function(paths3) {
        var val = obj;
        var idx = 0;
        var p;
        while(idx < paths3.length){
            if (val == null) {
                return;
            }
            p = paths3[idx];
            val = _isInteger(p) ? nth(p, val) : val[p];
            idx += 1;
        }
        return val;
    });
});
var path = _curry2(function path2(pathAr, obj) {
    return paths([
        pathAr
    ], obj)[0];
});
var prop = _curry2(function prop2(p, obj) {
    return path([
        p
    ], obj);
});
var pluck = _curry2(function pluck2(p, list16) {
    return map(prop(p), list16);
});
var reduce = _curry3(_reduce);
var allPass = _curry1(function allPass2(preds) {
    return curryN(reduce(max, 0, pluck("length", preds)), function() {
        var idx = 0;
        var len = preds.length;
        while(idx < len){
            if (!preds[idx].apply(this, arguments)) {
                return false;
            }
            idx += 1;
        }
        return true;
    });
});
var always = _curry1(function always2(val) {
    return function() {
        return val;
    };
});
var and = _curry2(function and2(a, b) {
    return a && b;
});
var XAny = function() {
    function XAny2(f, xf) {
        this.xf = xf;
        this.f = f;
        this.any = false;
    }
    XAny2.prototype["@@transducer/init"] = _xfBase.init;
    XAny2.prototype["@@transducer/result"] = function(result) {
        if (!this.any) {
            result = this.xf["@@transducer/step"](result, false);
        }
        return this.xf["@@transducer/result"](result);
    };
    XAny2.prototype["@@transducer/step"] = function(result, input) {
        if (this.f(input)) {
            this.any = true;
            result = _reduced(this.xf["@@transducer/step"](result, true));
        }
        return result;
    };
    return XAny2;
}();
var _xany = _curry2(function _xany2(f, xf) {
    return new XAny(f, xf);
});
var any = _curry2(_dispatchable([
    "any"
], _xany, function any2(fn, list17) {
    var idx = 0;
    while(idx < list17.length){
        if (fn(list17[idx])) {
            return true;
        }
        idx += 1;
    }
    return false;
}));
var anyPass = _curry1(function anyPass2(preds) {
    return curryN(reduce(max, 0, pluck("length", preds)), function() {
        var idx = 0;
        var len = preds.length;
        while(idx < len){
            if (preds[idx].apply(this, arguments)) {
                return true;
            }
            idx += 1;
        }
        return false;
    });
});
var ap = _curry2(function ap2(applyF, applyX) {
    return typeof applyX["fantasy-land/ap"] === "function" ? applyX["fantasy-land/ap"](applyF) : typeof applyF.ap === "function" ? applyF.ap(applyX) : typeof applyF === "function" ? function(x) {
        return applyF(x)(applyX(x));
    } : _reduce(function(acc, f) {
        return _concat(acc, map(f, applyX));
    }, [], applyF);
});
function _aperture(n, list18) {
    var idx = 0;
    var limit = list18.length - (n - 1);
    var acc = new Array(limit >= 0 ? limit : 0);
    while(idx < limit){
        acc[idx] = Array.prototype.slice.call(list18, idx, idx + n);
        idx += 1;
    }
    return acc;
}
var XAperture = function() {
    function XAperture2(n, xf) {
        this.xf = xf;
        this.pos = 0;
        this.full = false;
        this.acc = new Array(n);
    }
    XAperture2.prototype["@@transducer/init"] = _xfBase.init;
    XAperture2.prototype["@@transducer/result"] = function(result) {
        this.acc = null;
        return this.xf["@@transducer/result"](result);
    };
    XAperture2.prototype["@@transducer/step"] = function(result, input) {
        this.store(input);
        return this.full ? this.xf["@@transducer/step"](result, this.getCopy()) : result;
    };
    XAperture2.prototype.store = function(input) {
        this.acc[this.pos] = input;
        this.pos += 1;
        if (this.pos === this.acc.length) {
            this.pos = 0;
            this.full = true;
        }
    };
    XAperture2.prototype.getCopy = function() {
        return _concat(Array.prototype.slice.call(this.acc, this.pos), Array.prototype.slice.call(this.acc, 0, this.pos));
    };
    return XAperture2;
}();
var _xaperture = _curry2(function _xaperture2(n, xf) {
    return new XAperture(n, xf);
});
var aperture = _curry2(_dispatchable([], _xaperture, _aperture));
var append = _curry2(function append2(el, list19) {
    return _concat(list19, [
        el
    ]);
});
var apply = _curry2(function apply2(fn, args) {
    return fn.apply(this, args);
});
var values = _curry1(function values2(obj) {
    var props3 = keys(obj);
    var len = props3.length;
    var vals = [];
    var idx = 0;
    while(idx < len){
        vals[idx] = obj[props3[idx]];
        idx += 1;
    }
    return vals;
});
function mapValues(fn, obj) {
    return keys(obj).reduce(function(acc, key) {
        acc[key] = fn(obj[key]);
        return acc;
    }, {});
}
var applySpec = _curry1(function applySpec2(spec) {
    spec = mapValues(function(v) {
        return typeof v == "function" ? v : applySpec2(v);
    }, spec);
    return curryN(reduce(max, 0, pluck("length", values(spec))), function() {
        var args = arguments;
        return mapValues(function(f) {
            return apply(f, args);
        }, spec);
    });
});
var applyTo = _curry2(function applyTo2(x, f) {
    return f(x);
});
var ascend = _curry3(function ascend2(fn, a, b) {
    var aa = fn(a);
    var bb = fn(b);
    return aa < bb ? -1 : aa > bb ? 1 : 0;
});
var assoc = _curry3(function assoc2(prop3, val, obj) {
    var result = {};
    for(var p in obj){
        result[p] = obj[p];
    }
    result[prop3] = val;
    return result;
});
var isNil = _curry1(function isNil2(x) {
    return x == null;
});
var assocPath = _curry3(function assocPath2(path3, val, obj) {
    if (path3.length === 0) {
        return val;
    }
    var idx = path3[0];
    if (path3.length > 1) {
        var nextObj = !isNil(obj) && _has(idx, obj) ? obj[idx] : _isInteger(path3[1]) ? [] : {};
        val = assocPath2(Array.prototype.slice.call(path3, 1), val, nextObj);
    }
    if (_isInteger(idx) && _isArray(obj)) {
        var arr = [].concat(obj);
        arr[idx] = val;
        return arr;
    } else {
        return assoc(idx, val, obj);
    }
});
var nAry = _curry2(function nAry2(n, fn) {
    switch(n){
        case 0:
            return function() {
                return fn.call(this);
            };
        case 1:
            return function(a0) {
                return fn.call(this, a0);
            };
        case 2:
            return function(a0, a1) {
                return fn.call(this, a0, a1);
            };
        case 3:
            return function(a0, a1, a2) {
                return fn.call(this, a0, a1, a2);
            };
        case 4:
            return function(a0, a1, a2, a3) {
                return fn.call(this, a0, a1, a2, a3);
            };
        case 5:
            return function(a0, a1, a2, a3, a4) {
                return fn.call(this, a0, a1, a2, a3, a4);
            };
        case 6:
            return function(a0, a1, a2, a3, a4, a5) {
                return fn.call(this, a0, a1, a2, a3, a4, a5);
            };
        case 7:
            return function(a0, a1, a2, a3, a4, a5, a6) {
                return fn.call(this, a0, a1, a2, a3, a4, a5, a6);
            };
        case 8:
            return function(a0, a1, a2, a3, a4, a5, a6, a7) {
                return fn.call(this, a0, a1, a2, a3, a4, a5, a6, a7);
            };
        case 9:
            return function(a0, a1, a2, a3, a4, a5, a6, a7, a8) {
                return fn.call(this, a0, a1, a2, a3, a4, a5, a6, a7, a8);
            };
        case 10:
            return function(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
                return fn.call(this, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9);
            };
        default:
            throw new Error("First argument to nAry must be a non-negative integer no greater than ten");
    }
});
var binary = _curry1(function binary2(fn) {
    return nAry(2, fn);
});
function _isFunction(x) {
    var type3 = Object.prototype.toString.call(x);
    return type3 === "[object Function]" || type3 === "[object AsyncFunction]" || type3 === "[object GeneratorFunction]" || type3 === "[object AsyncGeneratorFunction]";
}
var liftN = _curry2(function liftN2(arity, fn) {
    var lifted = curryN(arity, fn);
    return curryN(arity, function() {
        return _reduce(ap, map(lifted, arguments[0]), Array.prototype.slice.call(arguments, 1));
    });
});
var lift = _curry1(function lift2(fn) {
    return liftN(fn.length, fn);
});
var both = _curry2(function both2(f, g) {
    return _isFunction(f) ? function _both() {
        return f.apply(this, arguments) && g.apply(this, arguments);
    } : lift(and)(f, g);
});
var curry = _curry1(function curry2(fn) {
    return curryN(fn.length, fn);
});
var call = curry(function call2(fn) {
    return fn.apply(this, Array.prototype.slice.call(arguments, 1));
});
function _makeFlat(recursive) {
    return function flatt(list20) {
        var value, jlen, j;
        var result = [];
        var idx = 0;
        var ilen = list20.length;
        while(idx < ilen){
            if (_isArrayLike(list20[idx])) {
                value = recursive ? flatt(list20[idx]) : list20[idx];
                j = 0;
                jlen = value.length;
                while(j < jlen){
                    result[result.length] = value[j];
                    j += 1;
                }
            } else {
                result[result.length] = list20[idx];
            }
            idx += 1;
        }
        return result;
    };
}
function _forceReduced(x) {
    return {
        "@@transducer/value": x,
        "@@transducer/reduced": true
    };
}
var preservingReduced = function(xf) {
    return {
        "@@transducer/init": _xfBase.init,
        "@@transducer/result": function(result) {
            return xf["@@transducer/result"](result);
        },
        "@@transducer/step": function(result, input) {
            var ret = xf["@@transducer/step"](result, input);
            return ret["@@transducer/reduced"] ? _forceReduced(ret) : ret;
        }
    };
};
var _flatCat = function _xcat(xf) {
    var rxf = preservingReduced(xf);
    return {
        "@@transducer/init": _xfBase.init,
        "@@transducer/result": function(result) {
            return rxf["@@transducer/result"](result);
        },
        "@@transducer/step": function(result, input) {
            return !_isArrayLike(input) ? _reduce(rxf, result, [
                input
            ]) : _reduce(rxf, result, input);
        }
    };
};
var _xchain = _curry2(function _xchain2(f, xf) {
    return map(f, _flatCat(xf));
});
var chain = _curry2(_dispatchable([
    "fantasy-land/chain",
    "chain"
], _xchain, function chain2(fn, monad) {
    if (typeof monad === "function") {
        return function(x) {
            return fn(monad(x))(x);
        };
    }
    return _makeFlat(false)(map(fn, monad));
}));
var clamp = _curry3(function clamp2(min3, max3, value) {
    if (min3 > max3) {
        throw new Error("min must not be greater than max in clamp(min, max, value)");
    }
    return value < min3 ? min3 : value > max3 ? max3 : value;
});
function _cloneRegExp(pattern) {
    return new RegExp(pattern.source, (pattern.global ? "g" : "") + (pattern.ignoreCase ? "i" : "") + (pattern.multiline ? "m" : "") + (pattern.sticky ? "y" : "") + (pattern.unicode ? "u" : ""));
}
var type = _curry1(function type2(val) {
    return val === null ? "Null" : val === void 0 ? "Undefined" : Object.prototype.toString.call(val).slice(8, -1);
});
function _clone(value, refFrom, refTo, deep) {
    var copy = function copy2(copiedValue) {
        var len = refFrom.length;
        var idx = 0;
        while(idx < len){
            if (value === refFrom[idx]) {
                return refTo[idx];
            }
            idx += 1;
        }
        refFrom[idx + 1] = value;
        refTo[idx + 1] = copiedValue;
        for(var key in value){
            copiedValue[key] = deep ? _clone(value[key], refFrom, refTo, true) : value[key];
        }
        return copiedValue;
    };
    switch(type(value)){
        case "Object":
            return copy({});
        case "Array":
            return copy([]);
        case "Date":
            return new Date(value.valueOf());
        case "RegExp":
            return _cloneRegExp(value);
        default:
            return value;
    }
}
var clone = _curry1(function clone2(value) {
    return value != null && typeof value.clone === "function" ? value.clone() : _clone(value, [], [], true);
});
var comparator = _curry1(function comparator2(pred) {
    return function(a, b) {
        return pred(a, b) ? -1 : pred(b, a) ? 1 : 0;
    };
});
var not = _curry1(function not2(a) {
    return !a;
});
var complement = lift(not);
function _pipe(f, g) {
    return function() {
        return g.call(this, f.apply(this, arguments));
    };
}
function _checkForMethod(methodname, fn) {
    return function() {
        var length3 = arguments.length;
        if (length3 === 0) {
            return fn();
        }
        var obj = arguments[length3 - 1];
        return _isArray(obj) || typeof obj[methodname] !== "function" ? fn.apply(this, arguments) : obj[methodname].apply(obj, Array.prototype.slice.call(arguments, 0, length3 - 1));
    };
}
var slice = _curry3(_checkForMethod("slice", function slice2(fromIndex, toIndex, list21) {
    return Array.prototype.slice.call(list21, fromIndex, toIndex);
}));
var tail = _curry1(_checkForMethod("tail", slice(1, Infinity)));
function pipe() {
    if (arguments.length === 0) {
        throw new Error("pipe requires at least one argument");
    }
    return _arity(arguments[0].length, reduce(_pipe, arguments[0], tail(arguments)));
}
var reverse = _curry1(function reverse2(list22) {
    return _isString(list22) ? list22.split("").reverse().join("") : Array.prototype.slice.call(list22, 0).reverse();
});
function compose() {
    if (arguments.length === 0) {
        throw new Error("compose requires at least one argument");
    }
    return pipe.apply(this, reverse(arguments));
}
function composeK() {
    if (arguments.length === 0) {
        throw new Error("composeK requires at least one argument");
    }
    var init2 = Array.prototype.slice.call(arguments);
    var last2 = init2.pop();
    return compose(compose.apply(this, map(chain, init2)), last2);
}
function _pipeP(f, g) {
    return function() {
        var ctx = this;
        return f.apply(ctx, arguments).then(function(x) {
            return g.call(ctx, x);
        });
    };
}
function pipeP() {
    if (arguments.length === 0) {
        throw new Error("pipeP requires at least one argument");
    }
    return _arity(arguments[0].length, reduce(_pipeP, arguments[0], tail(arguments)));
}
function composeP() {
    if (arguments.length === 0) {
        throw new Error("composeP requires at least one argument");
    }
    return pipeP.apply(this, reverse(arguments));
}
var head = nth(0);
function _identity(x) {
    return x;
}
var identity = _curry1(_identity);
var pipeWith = _curry2(function pipeWith2(xf, list23) {
    if (list23.length <= 0) {
        return identity;
    }
    var headList = head(list23);
    var tailList = tail(list23);
    return _arity(headList.length, function() {
        return _reduce(function(result, f) {
            return xf.call(this, f, result);
        }, headList.apply(this, arguments), tailList);
    });
});
var composeWith = _curry2(function composeWith2(xf, list24) {
    return pipeWith.apply(this, [
        xf,
        reverse(list24)
    ]);
});
function _arrayFromIterator(iter) {
    var list25 = [];
    var next;
    while(!(next = iter.next()).done){
        list25.push(next.value);
    }
    return list25;
}
function _includesWith(pred, x, list26) {
    var idx = 0;
    var len = list26.length;
    while(idx < len){
        if (pred(x, list26[idx])) {
            return true;
        }
        idx += 1;
    }
    return false;
}
function _functionName(f) {
    var match3 = String(f).match(/^function (\w*)/);
    return match3 == null ? "" : match3[1];
}
function _objectIs(a, b) {
    if (a === b) {
        return a !== 0 || 1 / a === 1 / b;
    } else {
        return a !== a && b !== b;
    }
}
var _objectIs$1 = typeof Object.is === "function" ? Object.is : _objectIs;
function _uniqContentEquals(aIterator, bIterator, stackA, stackB) {
    var a = _arrayFromIterator(aIterator);
    var b = _arrayFromIterator(bIterator);
    function eq(_a, _b) {
        return _equals(_a, _b, stackA.slice(), stackB.slice());
    }
    return !_includesWith(function(b2, aItem) {
        return !_includesWith(eq, aItem, b2);
    }, b, a);
}
function _equals(a, b, stackA, stackB) {
    if (_objectIs$1(a, b)) {
        return true;
    }
    var typeA = type(a);
    if (typeA !== type(b)) {
        return false;
    }
    if (a == null || b == null) {
        return false;
    }
    if (typeof a["fantasy-land/equals"] === "function" || typeof b["fantasy-land/equals"] === "function") {
        return typeof a["fantasy-land/equals"] === "function" && a["fantasy-land/equals"](b) && typeof b["fantasy-land/equals"] === "function" && b["fantasy-land/equals"](a);
    }
    if (typeof a.equals === "function" || typeof b.equals === "function") {
        return typeof a.equals === "function" && a.equals(b) && typeof b.equals === "function" && b.equals(a);
    }
    switch(typeA){
        case "Arguments":
        case "Array":
        case "Object":
            if (typeof a.constructor === "function" && _functionName(a.constructor) === "Promise") {
                return a === b;
            }
            break;
        case "Boolean":
        case "Number":
        case "String":
            if (!(typeof a === typeof b && _objectIs$1(a.valueOf(), b.valueOf()))) {
                return false;
            }
            break;
        case "Date":
            if (!_objectIs$1(a.valueOf(), b.valueOf())) {
                return false;
            }
            break;
        case "Error":
            return a.name === b.name && a.message === b.message;
        case "RegExp":
            if (!(a.source === b.source && a.global === b.global && a.ignoreCase === b.ignoreCase && a.multiline === b.multiline && a.sticky === b.sticky && a.unicode === b.unicode)) {
                return false;
            }
            break;
    }
    var idx = stackA.length - 1;
    while(idx >= 0){
        if (stackA[idx] === a) {
            return stackB[idx] === b;
        }
        idx -= 1;
    }
    switch(typeA){
        case "Map":
            if (a.size !== b.size) {
                return false;
            }
            return _uniqContentEquals(a.entries(), b.entries(), stackA.concat([
                a
            ]), stackB.concat([
                b
            ]));
        case "Set":
            if (a.size !== b.size) {
                return false;
            }
            return _uniqContentEquals(a.values(), b.values(), stackA.concat([
                a
            ]), stackB.concat([
                b
            ]));
        case "Arguments":
        case "Array":
        case "Object":
        case "Boolean":
        case "Number":
        case "String":
        case "Date":
        case "Error":
        case "RegExp":
        case "Int8Array":
        case "Uint8Array":
        case "Uint8ClampedArray":
        case "Int16Array":
        case "Uint16Array":
        case "Int32Array":
        case "Uint32Array":
        case "Float32Array":
        case "Float64Array":
        case "ArrayBuffer":
            break;
        default:
            return false;
    }
    var keysA = keys(a);
    if (keysA.length !== keys(b).length) {
        return false;
    }
    var extendedStackA = stackA.concat([
        a
    ]);
    var extendedStackB = stackB.concat([
        b
    ]);
    idx = keysA.length - 1;
    while(idx >= 0){
        var key = keysA[idx];
        if (!(_has(key, b) && _equals(b[key], a[key], extendedStackA, extendedStackB))) {
            return false;
        }
        idx -= 1;
    }
    return true;
}
var equals = _curry2(function equals2(a, b) {
    return _equals(a, b, [], []);
});
function _indexOf(list27, a, idx) {
    var inf, item;
    if (typeof list27.indexOf === "function") {
        switch(typeof a){
            case "number":
                if (a === 0) {
                    inf = 1 / a;
                    while(idx < list27.length){
                        item = list27[idx];
                        if (item === 0 && 1 / item === inf) {
                            return idx;
                        }
                        idx += 1;
                    }
                    return -1;
                } else if (a !== a) {
                    while(idx < list27.length){
                        item = list27[idx];
                        if (typeof item === "number" && item !== item) {
                            return idx;
                        }
                        idx += 1;
                    }
                    return -1;
                }
                return list27.indexOf(a, idx);
            case "string":
            case "boolean":
            case "function":
            case "undefined":
                return list27.indexOf(a, idx);
            case "object":
                if (a === null) {
                    return list27.indexOf(a, idx);
                }
        }
    }
    while(idx < list27.length){
        if (equals(list27[idx], a)) {
            return idx;
        }
        idx += 1;
    }
    return -1;
}
function _includes(a, list28) {
    return _indexOf(list28, a, 0) >= 0;
}
function _quote(s) {
    var escaped = s.replace(/\\/g, "\\\\").replace(/[\b]/g, "\\b").replace(/\f/g, "\\f").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/\v/g, "\\v").replace(/\0/g, "\\0");
    return '"' + escaped.replace(/"/g, '\\"') + '"';
}
var pad = function pad2(n) {
    return (n < 10 ? "0" : "") + n;
};
var _toISOString = typeof Date.prototype.toISOString === "function" ? function _toISOString2(d) {
    return d.toISOString();
} : function _toISOString3(d) {
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) + "." + (d.getUTCMilliseconds() / 1000).toFixed(3).slice(2, 5) + "Z";
};
function _complement(f) {
    return function() {
        return !f.apply(this, arguments);
    };
}
function _filter(fn, list29) {
    var idx = 0;
    var len = list29.length;
    var result = [];
    while(idx < len){
        if (fn(list29[idx])) {
            result[result.length] = list29[idx];
        }
        idx += 1;
    }
    return result;
}
function _isObject(x) {
    return Object.prototype.toString.call(x) === "[object Object]";
}
var XFilter = function() {
    function XFilter2(f, xf) {
        this.xf = xf;
        this.f = f;
    }
    XFilter2.prototype["@@transducer/init"] = _xfBase.init;
    XFilter2.prototype["@@transducer/result"] = _xfBase.result;
    XFilter2.prototype["@@transducer/step"] = function(result, input) {
        return this.f(input) ? this.xf["@@transducer/step"](result, input) : result;
    };
    return XFilter2;
}();
var _xfilter = _curry2(function _xfilter2(f, xf) {
    return new XFilter(f, xf);
});
var filter = _curry2(_dispatchable([
    "filter"
], _xfilter, function(pred, filterable) {
    return _isObject(filterable) ? _reduce(function(acc, key) {
        if (pred(filterable[key])) {
            acc[key] = filterable[key];
        }
        return acc;
    }, {}, keys(filterable)) : _filter(pred, filterable);
}));
var reject = _curry2(function reject2(pred, filterable) {
    return filter(_complement(pred), filterable);
});
function _toString(x, seen) {
    var recur = function recur2(y) {
        var xs = seen.concat([
            x
        ]);
        return _includes(y, xs) ? "<Circular>" : _toString(y, xs);
    };
    var mapPairs = function(obj, keys4) {
        return _map(function(k) {
            return _quote(k) + ": " + recur(obj[k]);
        }, keys4.slice().sort());
    };
    switch(Object.prototype.toString.call(x)){
        case "[object Arguments]":
            return "(function() { return arguments; }(" + _map(recur, x).join(", ") + "))";
        case "[object Array]":
            return "[" + _map(recur, x).concat(mapPairs(x, reject(function(k) {
                return /^\d+$/.test(k);
            }, keys(x)))).join(", ") + "]";
        case "[object Boolean]":
            return typeof x === "object" ? "new Boolean(" + recur(x.valueOf()) + ")" : x.toString();
        case "[object Date]":
            return "new Date(" + (isNaN(x.valueOf()) ? recur(NaN) : _quote(_toISOString(x))) + ")";
        case "[object Null]":
            return "null";
        case "[object Number]":
            return typeof x === "object" ? "new Number(" + recur(x.valueOf()) + ")" : 1 / x === -Infinity ? "-0" : x.toString(10);
        case "[object String]":
            return typeof x === "object" ? "new String(" + recur(x.valueOf()) + ")" : _quote(x);
        case "[object Undefined]":
            return "undefined";
        default:
            if (typeof x.toString === "function") {
                var repr = x.toString();
                if (repr !== "[object Object]") {
                    return repr;
                }
            }
            return "{" + mapPairs(x, keys(x)).join(", ") + "}";
    }
}
var toString$1 = _curry1(function toString2(val) {
    return _toString(val, []);
});
var concat = _curry2(function concat2(a, b) {
    if (_isArray(a)) {
        if (_isArray(b)) {
            return a.concat(b);
        }
        throw new TypeError(toString$1(b) + " is not an array");
    }
    if (_isString(a)) {
        if (_isString(b)) {
            return a + b;
        }
        throw new TypeError(toString$1(b) + " is not a string");
    }
    if (a != null && _isFunction(a["fantasy-land/concat"])) {
        return a["fantasy-land/concat"](b);
    }
    if (a != null && _isFunction(a.concat)) {
        return a.concat(b);
    }
    throw new TypeError(toString$1(a) + ' does not have a method named "concat" or "fantasy-land/concat"');
});
var cond = _curry1(function cond2(pairs) {
    var arity = reduce(max, 0, map(function(pair3) {
        return pair3[0].length;
    }, pairs));
    return _arity(arity, function() {
        var idx = 0;
        while(idx < pairs.length){
            if (pairs[idx][0].apply(this, arguments)) {
                return pairs[idx][1].apply(this, arguments);
            }
            idx += 1;
        }
    });
});
var constructN = _curry2(function constructN2(n, Fn) {
    if (n > 10) {
        throw new Error("Constructor with greater than ten arguments");
    }
    if (n === 0) {
        return function() {
            return new Fn();
        };
    }
    return curry(nAry(n, function($0, $1, $2, $3, $4, $5, $6, $7, $8, $9) {
        switch(arguments.length){
            case 1:
                return new Fn($0);
            case 2:
                return new Fn($0, $1);
            case 3:
                return new Fn($0, $1, $2);
            case 4:
                return new Fn($0, $1, $2, $3);
            case 5:
                return new Fn($0, $1, $2, $3, $4);
            case 6:
                return new Fn($0, $1, $2, $3, $4, $5);
            case 7:
                return new Fn($0, $1, $2, $3, $4, $5, $6);
            case 8:
                return new Fn($0, $1, $2, $3, $4, $5, $6, $7);
            case 9:
                return new Fn($0, $1, $2, $3, $4, $5, $6, $7, $8);
            case 10:
                return new Fn($0, $1, $2, $3, $4, $5, $6, $7, $8, $9);
        }
    }));
});
var construct = _curry1(function construct2(Fn) {
    return constructN(Fn.length, Fn);
});
var contains$1 = _curry2(_includes);
var converge = _curry2(function converge2(after, fns) {
    return curryN(reduce(max, 0, pluck("length", fns)), function() {
        var args = arguments;
        var context = this;
        return after.apply(context, _map(function(fn) {
            return fn.apply(context, args);
        }, fns));
    });
});
var XReduceBy = function() {
    function XReduceBy2(valueFn, valueAcc, keyFn, xf) {
        this.valueFn = valueFn;
        this.valueAcc = valueAcc;
        this.keyFn = keyFn;
        this.xf = xf;
        this.inputs = {};
    }
    XReduceBy2.prototype["@@transducer/init"] = _xfBase.init;
    XReduceBy2.prototype["@@transducer/result"] = function(result) {
        var key;
        for(key in this.inputs){
            if (_has(key, this.inputs)) {
                result = this.xf["@@transducer/step"](result, this.inputs[key]);
                if (result["@@transducer/reduced"]) {
                    result = result["@@transducer/value"];
                    break;
                }
            }
        }
        this.inputs = null;
        return this.xf["@@transducer/result"](result);
    };
    XReduceBy2.prototype["@@transducer/step"] = function(result, input) {
        var key = this.keyFn(input);
        this.inputs[key] = this.inputs[key] || [
            key,
            this.valueAcc
        ];
        this.inputs[key][1] = this.valueFn(this.inputs[key][1], input);
        return result;
    };
    return XReduceBy2;
}();
var _xreduceBy = _curryN(4, [], function _xreduceBy2(valueFn, valueAcc, keyFn, xf) {
    return new XReduceBy(valueFn, valueAcc, keyFn, xf);
});
var reduceBy = _curryN(4, [], _dispatchable([], _xreduceBy, function reduceBy2(valueFn, valueAcc, keyFn, list30) {
    return _reduce(function(acc, elt) {
        var key = keyFn(elt);
        acc[key] = valueFn(_has(key, acc) ? acc[key] : _clone(valueAcc, [], [], false), elt);
        return acc;
    }, {}, list30);
}));
var countBy = reduceBy(function(acc, elem) {
    return acc + 1;
}, 0);
var dec = add2(-1);
var defaultTo = _curry2(function defaultTo2(d, v) {
    return v == null || v !== v ? d : v;
});
var descend = _curry3(function descend2(fn, a, b) {
    var aa = fn(a);
    var bb = fn(b);
    return aa > bb ? -1 : aa < bb ? 1 : 0;
});
var _Set = function() {
    function _Set2() {
        this._nativeSet = typeof Set === "function" ? new Set() : null;
        this._items = {};
    }
    _Set2.prototype.add = function(item) {
        return !hasOrAdd(item, true, this);
    };
    _Set2.prototype.has = function(item) {
        return hasOrAdd(item, false, this);
    };
    return _Set2;
}();
function hasOrAdd(item, shouldAdd, set3) {
    var type3 = typeof item;
    var prevSize, newSize;
    switch(type3){
        case "string":
        case "number":
            if (item === 0 && 1 / item === -Infinity) {
                if (set3._items["-0"]) {
                    return true;
                } else {
                    if (shouldAdd) {
                        set3._items["-0"] = true;
                    }
                    return false;
                }
            }
            if (set3._nativeSet !== null) {
                if (shouldAdd) {
                    prevSize = set3._nativeSet.size;
                    set3._nativeSet.add(item);
                    newSize = set3._nativeSet.size;
                    return newSize === prevSize;
                } else {
                    return set3._nativeSet.has(item);
                }
            } else {
                if (!(type3 in set3._items)) {
                    if (shouldAdd) {
                        set3._items[type3] = {};
                        set3._items[type3][item] = true;
                    }
                    return false;
                } else if (item in set3._items[type3]) {
                    return true;
                } else {
                    if (shouldAdd) {
                        set3._items[type3][item] = true;
                    }
                    return false;
                }
            }
        case "boolean":
            if (type3 in set3._items) {
                var bIdx = item ? 1 : 0;
                if (set3._items[type3][bIdx]) {
                    return true;
                } else {
                    if (shouldAdd) {
                        set3._items[type3][bIdx] = true;
                    }
                    return false;
                }
            } else {
                if (shouldAdd) {
                    set3._items[type3] = item ? [
                        false,
                        true
                    ] : [
                        true,
                        false
                    ];
                }
                return false;
            }
        case "function":
            if (set3._nativeSet !== null) {
                if (shouldAdd) {
                    prevSize = set3._nativeSet.size;
                    set3._nativeSet.add(item);
                    newSize = set3._nativeSet.size;
                    return newSize === prevSize;
                } else {
                    return set3._nativeSet.has(item);
                }
            } else {
                if (!(type3 in set3._items)) {
                    if (shouldAdd) {
                        set3._items[type3] = [
                            item
                        ];
                    }
                    return false;
                }
                if (!_includes(item, set3._items[type3])) {
                    if (shouldAdd) {
                        set3._items[type3].push(item);
                    }
                    return false;
                }
                return true;
            }
        case "undefined":
            if (set3._items[type3]) {
                return true;
            } else {
                if (shouldAdd) {
                    set3._items[type3] = true;
                }
                return false;
            }
        case "object":
            if (item === null) {
                if (!set3._items["null"]) {
                    if (shouldAdd) {
                        set3._items["null"] = true;
                    }
                    return false;
                }
                return true;
            }
        default:
            type3 = Object.prototype.toString.call(item);
            if (!(type3 in set3._items)) {
                if (shouldAdd) {
                    set3._items[type3] = [
                        item
                    ];
                }
                return false;
            }
            if (!_includes(item, set3._items[type3])) {
                if (shouldAdd) {
                    set3._items[type3].push(item);
                }
                return false;
            }
            return true;
    }
}
var difference1 = _curry2(function difference2(first, second) {
    var out = [];
    var idx = 0;
    var firstLen = first.length;
    var secondLen = second.length;
    var toFilterOut = new _Set();
    for(var i25 = 0; i25 < secondLen; i25 += 1){
        toFilterOut.add(second[i25]);
    }
    while(idx < firstLen){
        if (toFilterOut.add(first[idx])) {
            out[out.length] = first[idx];
        }
        idx += 1;
    }
    return out;
});
var differenceWith = _curry3(function differenceWith2(pred, first, second) {
    var out = [];
    var idx = 0;
    var firstLen = first.length;
    while(idx < firstLen){
        if (!_includesWith(pred, first[idx], second) && !_includesWith(pred, first[idx], out)) {
            out.push(first[idx]);
        }
        idx += 1;
    }
    return out;
});
var dissoc = _curry2(function dissoc2(prop3, obj) {
    var result = {};
    for(var p in obj){
        result[p] = obj[p];
    }
    delete result[prop3];
    return result;
});
var remove2 = _curry3(function remove2(start, count, list31) {
    var result = Array.prototype.slice.call(list31, 0);
    result.splice(start, count);
    return result;
});
var update1 = _curry3(function update2(idx, x, list32) {
    return adjust(idx, always(x), list32);
});
var dissocPath = _curry2(function dissocPath2(path3, obj) {
    switch(path3.length){
        case 0:
            return obj;
        case 1:
            return _isInteger(path3[0]) && _isArray(obj) ? remove2(path3[0], 1, obj) : dissoc(path3[0], obj);
        default:
            var head2 = path3[0];
            var tail2 = Array.prototype.slice.call(path3, 1);
            if (obj[head2] == null) {
                return obj;
            } else if (_isInteger(head2) && _isArray(obj)) {
                return update1(head2, dissocPath2(tail2, obj[head2]), obj);
            } else {
                return assoc(head2, dissocPath2(tail2, obj[head2]), obj);
            }
    }
});
var divide = _curry2(function divide2(a, b) {
    return a / b;
});
var XDrop = function() {
    function XDrop2(n, xf) {
        this.xf = xf;
        this.n = n;
    }
    XDrop2.prototype["@@transducer/init"] = _xfBase.init;
    XDrop2.prototype["@@transducer/result"] = _xfBase.result;
    XDrop2.prototype["@@transducer/step"] = function(result, input) {
        if (this.n > 0) {
            this.n -= 1;
            return result;
        }
        return this.xf["@@transducer/step"](result, input);
    };
    return XDrop2;
}();
var _xdrop = _curry2(function _xdrop2(n, xf) {
    return new XDrop(n, xf);
});
var drop = _curry2(_dispatchable([
    "drop"
], _xdrop, function drop2(n, xs) {
    return slice(Math.max(0, n), Infinity, xs);
}));
var XTake = function() {
    function XTake2(n, xf) {
        this.xf = xf;
        this.n = n;
        this.i = 0;
    }
    XTake2.prototype["@@transducer/init"] = _xfBase.init;
    XTake2.prototype["@@transducer/result"] = _xfBase.result;
    XTake2.prototype["@@transducer/step"] = function(result, input) {
        this.i += 1;
        var ret = this.n === 0 ? result : this.xf["@@transducer/step"](result, input);
        return this.n >= 0 && this.i >= this.n ? _reduced(ret) : ret;
    };
    return XTake2;
}();
var _xtake = _curry2(function _xtake2(n, xf) {
    return new XTake(n, xf);
});
var take = _curry2(_dispatchable([
    "take"
], _xtake, function take2(n, xs) {
    return slice(0, n < 0 ? Infinity : n, xs);
}));
function dropLast(n, xs) {
    return take(n < xs.length ? xs.length - n : 0, xs);
}
var XDropLast = function() {
    function XDropLast2(n, xf) {
        this.xf = xf;
        this.pos = 0;
        this.full = false;
        this.acc = new Array(n);
    }
    XDropLast2.prototype["@@transducer/init"] = _xfBase.init;
    XDropLast2.prototype["@@transducer/result"] = function(result) {
        this.acc = null;
        return this.xf["@@transducer/result"](result);
    };
    XDropLast2.prototype["@@transducer/step"] = function(result, input) {
        if (this.full) {
            result = this.xf["@@transducer/step"](result, this.acc[this.pos]);
        }
        this.store(input);
        return result;
    };
    XDropLast2.prototype.store = function(input) {
        this.acc[this.pos] = input;
        this.pos += 1;
        if (this.pos === this.acc.length) {
            this.pos = 0;
            this.full = true;
        }
    };
    return XDropLast2;
}();
var _xdropLast = _curry2(function _xdropLast2(n, xf) {
    return new XDropLast(n, xf);
});
var dropLast$1 = _curry2(_dispatchable([], _xdropLast, dropLast));
function dropLastWhile(pred, xs) {
    var idx = xs.length - 1;
    while(idx >= 0 && pred(xs[idx])){
        idx -= 1;
    }
    return slice(0, idx + 1, xs);
}
var XDropLastWhile = function() {
    function XDropLastWhile2(fn, xf) {
        this.f = fn;
        this.retained = [];
        this.xf = xf;
    }
    XDropLastWhile2.prototype["@@transducer/init"] = _xfBase.init;
    XDropLastWhile2.prototype["@@transducer/result"] = function(result) {
        this.retained = null;
        return this.xf["@@transducer/result"](result);
    };
    XDropLastWhile2.prototype["@@transducer/step"] = function(result, input) {
        return this.f(input) ? this.retain(result, input) : this.flush(result, input);
    };
    XDropLastWhile2.prototype.flush = function(result, input) {
        result = _reduce(this.xf["@@transducer/step"], result, this.retained);
        this.retained = [];
        return this.xf["@@transducer/step"](result, input);
    };
    XDropLastWhile2.prototype.retain = function(result, input) {
        this.retained.push(input);
        return result;
    };
    return XDropLastWhile2;
}();
var _xdropLastWhile = _curry2(function _xdropLastWhile2(fn, xf) {
    return new XDropLastWhile(fn, xf);
});
var dropLastWhile$1 = _curry2(_dispatchable([], _xdropLastWhile, dropLastWhile));
var XDropRepeatsWith = function() {
    function XDropRepeatsWith2(pred, xf) {
        this.xf = xf;
        this.pred = pred;
        this.lastValue = void 0;
        this.seenFirstValue = false;
    }
    XDropRepeatsWith2.prototype["@@transducer/init"] = _xfBase.init;
    XDropRepeatsWith2.prototype["@@transducer/result"] = _xfBase.result;
    XDropRepeatsWith2.prototype["@@transducer/step"] = function(result, input) {
        var sameAsLast = false;
        if (!this.seenFirstValue) {
            this.seenFirstValue = true;
        } else if (this.pred(this.lastValue, input)) {
            sameAsLast = true;
        }
        this.lastValue = input;
        return sameAsLast ? result : this.xf["@@transducer/step"](result, input);
    };
    return XDropRepeatsWith2;
}();
var _xdropRepeatsWith = _curry2(function _xdropRepeatsWith2(pred, xf) {
    return new XDropRepeatsWith(pred, xf);
});
var last = nth(-1);
var dropRepeatsWith = _curry2(_dispatchable([], _xdropRepeatsWith, function dropRepeatsWith2(pred, list33) {
    var result = [];
    var idx = 1;
    var len = list33.length;
    if (len !== 0) {
        result[0] = list33[0];
        while(idx < len){
            if (!pred(last(result), list33[idx])) {
                result[result.length] = list33[idx];
            }
            idx += 1;
        }
    }
    return result;
}));
var dropRepeats = _curry1(_dispatchable([], _xdropRepeatsWith(equals), dropRepeatsWith(equals)));
var XDropWhile = function() {
    function XDropWhile2(f, xf) {
        this.xf = xf;
        this.f = f;
    }
    XDropWhile2.prototype["@@transducer/init"] = _xfBase.init;
    XDropWhile2.prototype["@@transducer/result"] = _xfBase.result;
    XDropWhile2.prototype["@@transducer/step"] = function(result, input) {
        if (this.f) {
            if (this.f(input)) {
                return result;
            }
            this.f = null;
        }
        return this.xf["@@transducer/step"](result, input);
    };
    return XDropWhile2;
}();
var _xdropWhile = _curry2(function _xdropWhile2(f, xf) {
    return new XDropWhile(f, xf);
});
var dropWhile = _curry2(_dispatchable([
    "dropWhile"
], _xdropWhile, function dropWhile2(pred, xs) {
    var idx = 0;
    var len = xs.length;
    while(idx < len && pred(xs[idx])){
        idx += 1;
    }
    return slice(idx, Infinity, xs);
}));
var or = _curry2(function or2(a, b) {
    return a || b;
});
var either = _curry2(function either2(f, g) {
    return _isFunction(f) ? function _either() {
        return f.apply(this, arguments) || g.apply(this, arguments);
    } : lift(or)(f, g);
});
var empty = _curry1(function empty2(x) {
    return x != null && typeof x["fantasy-land/empty"] === "function" ? x["fantasy-land/empty"]() : x != null && x.constructor != null && typeof x.constructor["fantasy-land/empty"] === "function" ? x.constructor["fantasy-land/empty"]() : x != null && typeof x.empty === "function" ? x.empty() : x != null && x.constructor != null && typeof x.constructor.empty === "function" ? x.constructor.empty() : _isArray(x) ? [] : _isString(x) ? "" : _isObject(x) ? {} : _isArguments(x) ? (function() {
        return arguments;
    })() : void 0;
});
var takeLast = _curry2(function takeLast2(n, xs) {
    return drop(n >= 0 ? xs.length - n : 0, xs);
});
var endsWith = _curry2(function(suffix, list34) {
    return equals(takeLast(suffix.length, list34), suffix);
});
var eqBy = _curry3(function eqBy2(f, x, y) {
    return equals(f(x), f(y));
});
var eqProps = _curry3(function eqProps2(prop3, obj1, obj2) {
    return equals(obj1[prop3], obj2[prop3]);
});
var evolve = _curry2(function evolve2(transformations, object) {
    var result = object instanceof Array ? [] : {};
    var transformation, key, type3;
    for(key in object){
        transformation = transformations[key];
        type3 = typeof transformation;
        result[key] = type3 === "function" ? transformation(object[key]) : transformation && type3 === "object" ? evolve2(transformation, object[key]) : object[key];
    }
    return result;
});
var XFind = function() {
    function XFind2(f, xf) {
        this.xf = xf;
        this.f = f;
        this.found = false;
    }
    XFind2.prototype["@@transducer/init"] = _xfBase.init;
    XFind2.prototype["@@transducer/result"] = function(result) {
        if (!this.found) {
            result = this.xf["@@transducer/step"](result, void 0);
        }
        return this.xf["@@transducer/result"](result);
    };
    XFind2.prototype["@@transducer/step"] = function(result, input) {
        if (this.f(input)) {
            this.found = true;
            result = _reduced(this.xf["@@transducer/step"](result, input));
        }
        return result;
    };
    return XFind2;
}();
var _xfind = _curry2(function _xfind2(f, xf) {
    return new XFind(f, xf);
});
var find1 = _curry2(_dispatchable([
    "find"
], _xfind, function find2(fn, list35) {
    var idx = 0;
    var len = list35.length;
    while(idx < len){
        if (fn(list35[idx])) {
            return list35[idx];
        }
        idx += 1;
    }
}));
var XFindIndex = function() {
    function XFindIndex2(f, xf) {
        this.xf = xf;
        this.f = f;
        this.idx = -1;
        this.found = false;
    }
    XFindIndex2.prototype["@@transducer/init"] = _xfBase.init;
    XFindIndex2.prototype["@@transducer/result"] = function(result) {
        if (!this.found) {
            result = this.xf["@@transducer/step"](result, -1);
        }
        return this.xf["@@transducer/result"](result);
    };
    XFindIndex2.prototype["@@transducer/step"] = function(result, input) {
        this.idx += 1;
        if (this.f(input)) {
            this.found = true;
            result = _reduced(this.xf["@@transducer/step"](result, this.idx));
        }
        return result;
    };
    return XFindIndex2;
}();
var _xfindIndex = _curry2(function _xfindIndex2(f, xf) {
    return new XFindIndex(f, xf);
});
var findIndex = _curry2(_dispatchable([], _xfindIndex, function findIndex2(fn, list36) {
    var idx = 0;
    var len = list36.length;
    while(idx < len){
        if (fn(list36[idx])) {
            return idx;
        }
        idx += 1;
    }
    return -1;
}));
var XFindLast = function() {
    function XFindLast2(f, xf) {
        this.xf = xf;
        this.f = f;
    }
    XFindLast2.prototype["@@transducer/init"] = _xfBase.init;
    XFindLast2.prototype["@@transducer/result"] = function(result) {
        return this.xf["@@transducer/result"](this.xf["@@transducer/step"](result, this.last));
    };
    XFindLast2.prototype["@@transducer/step"] = function(result, input) {
        if (this.f(input)) {
            this.last = input;
        }
        return result;
    };
    return XFindLast2;
}();
var _xfindLast = _curry2(function _xfindLast2(f, xf) {
    return new XFindLast(f, xf);
});
var findLast = _curry2(_dispatchable([], _xfindLast, function findLast2(fn, list37) {
    var idx = list37.length - 1;
    while(idx >= 0){
        if (fn(list37[idx])) {
            return list37[idx];
        }
        idx -= 1;
    }
}));
var XFindLastIndex = function() {
    function XFindLastIndex2(f, xf) {
        this.xf = xf;
        this.f = f;
        this.idx = -1;
        this.lastIdx = -1;
    }
    XFindLastIndex2.prototype["@@transducer/init"] = _xfBase.init;
    XFindLastIndex2.prototype["@@transducer/result"] = function(result) {
        return this.xf["@@transducer/result"](this.xf["@@transducer/step"](result, this.lastIdx));
    };
    XFindLastIndex2.prototype["@@transducer/step"] = function(result, input) {
        this.idx += 1;
        if (this.f(input)) {
            this.lastIdx = this.idx;
        }
        return result;
    };
    return XFindLastIndex2;
}();
var _xfindLastIndex = _curry2(function _xfindLastIndex2(f, xf) {
    return new XFindLastIndex(f, xf);
});
var findLastIndex = _curry2(_dispatchable([], _xfindLastIndex, function findLastIndex2(fn, list38) {
    var idx = list38.length - 1;
    while(idx >= 0){
        if (fn(list38[idx])) {
            return idx;
        }
        idx -= 1;
    }
    return -1;
}));
var flatten = _curry1(_makeFlat(true));
var flip = _curry1(function flip2(fn) {
    return curryN(fn.length, function(a, b) {
        var args = Array.prototype.slice.call(arguments, 0);
        args[0] = b;
        args[1] = a;
        return fn.apply(this, args);
    });
});
var forEach = _curry2(_checkForMethod("forEach", function forEach2(fn, list39) {
    var len = list39.length;
    var idx = 0;
    while(idx < len){
        fn(list39[idx]);
        idx += 1;
    }
    return list39;
}));
var forEachObjIndexed = _curry2(function forEachObjIndexed2(fn, obj) {
    var keyList = keys(obj);
    var idx = 0;
    while(idx < keyList.length){
        var key = keyList[idx];
        fn(obj[key], key, obj);
        idx += 1;
    }
    return obj;
});
var fromPairs = _curry1(function fromPairs2(pairs) {
    var result = {};
    var idx = 0;
    while(idx < pairs.length){
        result[pairs[idx][0]] = pairs[idx][1];
        idx += 1;
    }
    return result;
});
var groupBy = _curry2(_checkForMethod("groupBy", reduceBy(function(acc, item) {
    if (acc == null) {
        acc = [];
    }
    acc.push(item);
    return acc;
}, null)));
var groupWith = _curry2(function(fn, list40) {
    var res = [];
    var idx = 0;
    var len = list40.length;
    while(idx < len){
        var nextidx = idx + 1;
        while(nextidx < len && fn(list40[nextidx - 1], list40[nextidx])){
            nextidx += 1;
        }
        res.push(list40.slice(idx, nextidx));
        idx = nextidx;
    }
    return res;
});
var gt = _curry2(function gt2(a, b) {
    return a > b;
});
var gte = _curry2(function gte2(a, b) {
    return a >= b;
});
var hasPath = _curry2(function hasPath2(_path, obj) {
    if (_path.length === 0 || isNil(obj)) {
        return false;
    }
    var val = obj;
    var idx = 0;
    while(idx < _path.length){
        if (!isNil(val) && _has(_path[idx], val)) {
            val = val[_path[idx]];
            idx += 1;
        } else {
            return false;
        }
    }
    return true;
});
var has = _curry2(function has2(prop3, obj) {
    return hasPath([
        prop3
    ], obj);
});
var hasIn = _curry2(function hasIn2(prop3, obj) {
    return prop3 in obj;
});
var identical = _curry2(_objectIs$1);
var ifElse = _curry3(function ifElse2(condition, onTrue, onFalse) {
    return curryN(Math.max(condition.length, onTrue.length, onFalse.length), function _ifElse() {
        return condition.apply(this, arguments) ? onTrue.apply(this, arguments) : onFalse.apply(this, arguments);
    });
});
var inc = add2(1);
var includes = _curry2(_includes);
var indexBy = reduceBy(function(acc, elem) {
    return elem;
}, null);
var indexOf = _curry2(function indexOf2(target, xs) {
    return typeof xs.indexOf === "function" && !_isArray(xs) ? xs.indexOf(target) : _indexOf(xs, target, 0);
});
var init = slice(0, -1);
var innerJoin = _curry3(function innerJoin2(pred, xs, ys) {
    return _filter(function(x) {
        return _includesWith(pred, x, ys);
    }, xs);
});
var insert = _curry3(function insert2(idx, elt, list41) {
    idx = idx < list41.length && idx >= 0 ? idx : list41.length;
    var result = Array.prototype.slice.call(list41, 0);
    result.splice(idx, 0, elt);
    return result;
});
var insertAll = _curry3(function insertAll2(idx, elts, list42) {
    idx = idx < list42.length && idx >= 0 ? idx : list42.length;
    return [].concat(Array.prototype.slice.call(list42, 0, idx), elts, Array.prototype.slice.call(list42, idx));
});
var uniqBy = _curry2(function uniqBy2(fn, list43) {
    var set3 = new _Set();
    var result = [];
    var idx = 0;
    var appliedItem, item;
    while(idx < list43.length){
        item = list43[idx];
        appliedItem = fn(item);
        if (set3.add(appliedItem)) {
            result.push(item);
        }
        idx += 1;
    }
    return result;
});
var uniq1 = uniqBy(identity);
var intersection = _curry2(function intersection2(list1, list2) {
    var lookupList, filteredList;
    if (list1.length > list2.length) {
        lookupList = list1;
        filteredList = list2;
    } else {
        lookupList = list2;
        filteredList = list1;
    }
    return uniq1(_filter(flip(_includes)(lookupList), filteredList));
});
var intersperse = _curry2(_checkForMethod("intersperse", function intersperse2(separator, list44) {
    var out = [];
    var idx = 0;
    var length3 = list44.length;
    while(idx < length3){
        if (idx === length3 - 1) {
            out.push(list44[idx]);
        } else {
            out.push(list44[idx], separator);
        }
        idx += 1;
    }
    return out;
}));
function _objectAssign(target) {
    if (target == null) {
        throw new TypeError("Cannot convert undefined or null to object");
    }
    var output = Object(target);
    var idx = 1;
    var length3 = arguments.length;
    while(idx < length3){
        var source = arguments[idx];
        if (source != null) {
            for(var nextKey in source){
                if (_has(nextKey, source)) {
                    output[nextKey] = source[nextKey];
                }
            }
        }
        idx += 1;
    }
    return output;
}
var _objectAssign$1 = typeof Object.assign === "function" ? Object.assign : _objectAssign;
var objOf = _curry2(function objOf2(key, val) {
    var obj = {};
    obj[key] = val;
    return obj;
});
var _stepCatArray = {
    "@@transducer/init": Array,
    "@@transducer/step": function(xs, x) {
        xs.push(x);
        return xs;
    },
    "@@transducer/result": _identity
};
var _stepCatString = {
    "@@transducer/init": String,
    "@@transducer/step": function(a, b) {
        return a + b;
    },
    "@@transducer/result": _identity
};
var _stepCatObject = {
    "@@transducer/init": Object,
    "@@transducer/step": function(result, input) {
        return _objectAssign$1(result, _isArrayLike(input) ? objOf(input[0], input[1]) : input);
    },
    "@@transducer/result": _identity
};
function _stepCat(obj) {
    if (_isTransformer(obj)) {
        return obj;
    }
    if (_isArrayLike(obj)) {
        return _stepCatArray;
    }
    if (typeof obj === "string") {
        return _stepCatString;
    }
    if (typeof obj === "object") {
        return _stepCatObject;
    }
    throw new Error("Cannot create transformer for " + obj);
}
var into = _curry3(function into2(acc, xf, list45) {
    return _isTransformer(acc) ? _reduce(xf(acc), acc["@@transducer/init"](), list45) : _reduce(xf(_stepCat(acc)), _clone(acc, [], [], false), list45);
});
var invert = _curry1(function invert2(obj) {
    var props3 = keys(obj);
    var len = props3.length;
    var idx = 0;
    var out = {};
    while(idx < len){
        var key = props3[idx];
        var val = obj[key];
        var list46 = _has(val, out) ? out[val] : out[val] = [];
        list46[list46.length] = key;
        idx += 1;
    }
    return out;
});
var invertObj = _curry1(function invertObj2(obj) {
    var props3 = keys(obj);
    var len = props3.length;
    var idx = 0;
    var out = {};
    while(idx < len){
        var key = props3[idx];
        out[obj[key]] = key;
        idx += 1;
    }
    return out;
});
var invoker = _curry2(function invoker2(arity, method) {
    return curryN(arity + 1, function() {
        var target = arguments[arity];
        if (target != null && _isFunction(target[method])) {
            return target[method].apply(target, Array.prototype.slice.call(arguments, 0, arity));
        }
        throw new TypeError(toString$1(target) + ' does not have a method named "' + method + '"');
    });
});
var is = _curry2(function is2(Ctor, val) {
    return val != null && val.constructor === Ctor || val instanceof Ctor;
});
var isEmpty = _curry1(function isEmpty2(x) {
    return x != null && equals(x, empty(x));
});
var join1 = invoker(1, "join");
var juxt = _curry1(function juxt2(fns) {
    return converge(function() {
        return Array.prototype.slice.call(arguments, 0);
    }, fns);
});
var keysIn = _curry1(function keysIn2(obj) {
    var prop3;
    var ks = [];
    for(prop3 in obj){
        ks[ks.length] = prop3;
    }
    return ks;
});
var lastIndexOf = _curry2(function lastIndexOf2(target, xs) {
    if (typeof xs.lastIndexOf === "function" && !_isArray(xs)) {
        return xs.lastIndexOf(target);
    } else {
        var idx = xs.length - 1;
        while(idx >= 0){
            if (equals(xs[idx], target)) {
                return idx;
            }
            idx -= 1;
        }
        return -1;
    }
});
function _isNumber(x) {
    return Object.prototype.toString.call(x) === "[object Number]";
}
var length = _curry1(function length2(list47) {
    return list47 != null && _isNumber(list47.length) ? list47.length : NaN;
});
var lens = _curry2(function lens2(getter, setter) {
    return function(toFunctorFn) {
        return function(target) {
            return map(function(focus) {
                return setter(focus, target);
            }, toFunctorFn(getter(target)));
        };
    };
});
var lensIndex = _curry1(function lensIndex2(n) {
    return lens(nth(n), update1(n));
});
var lensPath = _curry1(function lensPath2(p) {
    return lens(path(p), assocPath(p));
});
var lensProp = _curry1(function lensProp2(k) {
    return lens(prop(k), assoc(k));
});
var lt = _curry2(function lt2(a, b) {
    return a < b;
});
var lte = _curry2(function lte2(a, b) {
    return a <= b;
});
var mapAccum = _curry3(function mapAccum2(fn, acc, list48) {
    var idx = 0;
    var len = list48.length;
    var result = [];
    var tuple = [
        acc
    ];
    while(idx < len){
        tuple = fn(tuple[0], list48[idx]);
        result[idx] = tuple[1];
        idx += 1;
    }
    return [
        tuple[0],
        result
    ];
});
var mapAccumRight = _curry3(function mapAccumRight2(fn, acc, list49) {
    var idx = list49.length - 1;
    var result = [];
    var tuple = [
        acc
    ];
    while(idx >= 0){
        tuple = fn(tuple[0], list49[idx]);
        result[idx] = tuple[1];
        idx -= 1;
    }
    return [
        tuple[0],
        result
    ];
});
var mapObjIndexed = _curry2(function mapObjIndexed2(fn, obj) {
    return _reduce(function(acc, key) {
        acc[key] = fn(obj[key], key, obj);
        return acc;
    }, {}, keys(obj));
});
var match = _curry2(function match2(rx, str) {
    return str.match(rx) || [];
});
var mathMod = _curry2(function mathMod2(m, p) {
    if (!_isInteger(m)) {
        return NaN;
    }
    if (!_isInteger(p) || p < 1) {
        return NaN;
    }
    return (m % p + p) % p;
});
var maxBy = _curry3(function maxBy2(f, a, b) {
    return f(b) > f(a) ? b : a;
});
var sum = reduce(add2, 0);
var mean = _curry1(function mean2(list50) {
    return sum(list50) / list50.length;
});
var median = _curry1(function median2(list51) {
    var len = list51.length;
    if (len === 0) {
        return NaN;
    }
    var width = 2 - len % 2;
    var idx = (len - width) / 2;
    return mean(Array.prototype.slice.call(list51, 0).sort(function(a, b) {
        return a < b ? -1 : a > b ? 1 : 0;
    }).slice(idx, idx + width));
});
var memoizeWith = _curry2(function memoizeWith2(mFn, fn) {
    var cache = {};
    return _arity(fn.length, function() {
        var key = mFn.apply(this, arguments);
        if (!_has(key, cache)) {
            cache[key] = fn.apply(this, arguments);
        }
        return cache[key];
    });
});
var merge = _curry2(function merge2(l2, r) {
    return _objectAssign$1({}, l2, r);
});
var mergeAll = _curry1(function mergeAll2(list52) {
    return _objectAssign$1.apply(null, [
        {}
    ].concat(list52));
});
var mergeWithKey = _curry3(function mergeWithKey2(fn, l3, r) {
    var result = {};
    var k;
    for(k in l3){
        if (_has(k, l3)) {
            result[k] = _has(k, r) ? fn(k, l3[k], r[k]) : l3[k];
        }
    }
    for(k in r){
        if (_has(k, r) && !_has(k, result)) {
            result[k] = r[k];
        }
    }
    return result;
});
var mergeDeepWithKey = _curry3(function mergeDeepWithKey2(fn, lObj, rObj) {
    return mergeWithKey(function(k, lVal, rVal) {
        if (_isObject(lVal) && _isObject(rVal)) {
            return mergeDeepWithKey2(fn, lVal, rVal);
        } else {
            return fn(k, lVal, rVal);
        }
    }, lObj, rObj);
});
var mergeDeepLeft = _curry2(function mergeDeepLeft2(lObj, rObj) {
    return mergeDeepWithKey(function(k, lVal, rVal) {
        return lVal;
    }, lObj, rObj);
});
var mergeDeepRight = _curry2(function mergeDeepRight2(lObj, rObj) {
    return mergeDeepWithKey(function(k, lVal, rVal) {
        return rVal;
    }, lObj, rObj);
});
var mergeDeepWith = _curry3(function mergeDeepWith2(fn, lObj, rObj) {
    return mergeDeepWithKey(function(k, lVal, rVal) {
        return fn(lVal, rVal);
    }, lObj, rObj);
});
var mergeLeft = _curry2(function mergeLeft2(l4, r) {
    return _objectAssign$1({}, r, l4);
});
var mergeRight = _curry2(function mergeRight2(l5, r) {
    return _objectAssign$1({}, l5, r);
});
var mergeWith = _curry3(function mergeWith2(fn, l6, r) {
    return mergeWithKey(function(_, _l, _r) {
        return fn(_l, _r);
    }, l6, r);
});
var min = _curry2(function min2(a, b) {
    return b < a ? b : a;
});
var minBy = _curry3(function minBy2(f, a, b) {
    return f(b) < f(a) ? b : a;
});
var modulo = _curry2(function modulo2(a, b) {
    return a % b;
});
var move = _curry3(function(from, to, list53) {
    var length3 = list53.length;
    var result = list53.slice();
    var positiveFrom = from < 0 ? length3 + from : from;
    var positiveTo = to < 0 ? length3 + to : to;
    var item = result.splice(positiveFrom, 1);
    return positiveFrom < 0 || positiveFrom >= list53.length || positiveTo < 0 || positiveTo >= list53.length ? list53 : [].concat(result.slice(0, positiveTo)).concat(item).concat(result.slice(positiveTo, list53.length));
});
var multiply = _curry2(function multiply2(a, b) {
    return a * b;
});
var negate = _curry1(function negate2(n) {
    return -n;
});
var none = _curry2(function none2(fn, input) {
    return all(_complement(fn), input);
});
var nthArg = _curry1(function nthArg2(n) {
    var arity = n < 0 ? 1 : n + 1;
    return curryN(arity, function() {
        return nth(n, arguments);
    });
});
var o = _curry3(function o2(f, g, x) {
    return f(g(x));
});
function _of(x) {
    return [
        x
    ];
}
var of = _curry1(_of);
var omit = _curry2(function omit2(names, obj) {
    var result = {};
    var index4 = {};
    var idx = 0;
    var len = names.length;
    while(idx < len){
        index4[names[idx]] = 1;
        idx += 1;
    }
    for(var prop3 in obj){
        if (!index4.hasOwnProperty(prop3)) {
            result[prop3] = obj[prop3];
        }
    }
    return result;
});
var once = _curry1(function once2(fn) {
    var called = false;
    var result;
    return _arity(fn.length, function() {
        if (called) {
            return result;
        }
        called = true;
        result = fn.apply(this, arguments);
        return result;
    });
});
function _assertPromise(name, p) {
    if (p == null || !_isFunction(p.then)) {
        throw new TypeError("`" + name + "` expected a Promise, received " + _toString(p, []));
    }
}
var otherwise = _curry2(function otherwise2(f, p) {
    _assertPromise("otherwise", p);
    return p.then(null, f);
});
var Identity = function(x) {
    return {
        value: x,
        map: function(f) {
            return Identity(f(x));
        }
    };
};
var over = _curry3(function over2(lens3, f, x) {
    return lens3(function(y) {
        return Identity(f(y));
    })(x).value;
});
var pair = _curry2(function pair2(fst, snd) {
    return [
        fst,
        snd
    ];
});
function _createPartialApplicator(concat3) {
    return _curry2(function(fn, args) {
        return _arity(Math.max(0, fn.length - args.length), function() {
            return fn.apply(this, concat3(args, arguments));
        });
    });
}
var partial = _createPartialApplicator(_concat);
var partialRight = _createPartialApplicator(flip(_concat));
var partition = juxt([
    filter,
    reject
]);
var pathEq = _curry3(function pathEq2(_path, val, obj) {
    return equals(path(_path, obj), val);
});
var pathOr = _curry3(function pathOr2(d, p, obj) {
    return defaultTo(d, path(p, obj));
});
var pathSatisfies = _curry3(function pathSatisfies2(pred, propPath, obj) {
    return pred(path(propPath, obj));
});
var pick = _curry2(function pick2(names, obj) {
    var result = {};
    var idx = 0;
    while(idx < names.length){
        if (names[idx] in obj) {
            result[names[idx]] = obj[names[idx]];
        }
        idx += 1;
    }
    return result;
});
var pickAll = _curry2(function pickAll2(names, obj) {
    var result = {};
    var idx = 0;
    var len = names.length;
    while(idx < len){
        var name = names[idx];
        result[name] = obj[name];
        idx += 1;
    }
    return result;
});
var pickBy = _curry2(function pickBy2(test3, obj) {
    var result = {};
    for(var prop3 in obj){
        if (test3(obj[prop3], prop3, obj)) {
            result[prop3] = obj[prop3];
        }
    }
    return result;
});
function pipeK() {
    if (arguments.length === 0) {
        throw new Error("pipeK requires at least one argument");
    }
    return composeK.apply(this, reverse(arguments));
}
var prepend = _curry2(function prepend2(el, list54) {
    return _concat([
        el
    ], list54);
});
var product = reduce(multiply, 1);
var useWith = _curry2(function useWith2(fn, transformers) {
    return curryN(transformers.length, function() {
        var args = [];
        var idx = 0;
        while(idx < transformers.length){
            args.push(transformers[idx].call(this, arguments[idx]));
            idx += 1;
        }
        return fn.apply(this, args.concat(Array.prototype.slice.call(arguments, transformers.length)));
    });
});
var project = useWith(_map, [
    pickAll,
    identity
]);
var propEq = _curry3(function propEq2(name, val, obj) {
    return equals(val, obj[name]);
});
var propIs = _curry3(function propIs2(type3, name, obj) {
    return is(type3, obj[name]);
});
var propOr = _curry3(function propOr2(val, p, obj) {
    return pathOr(val, [
        p
    ], obj);
});
var propSatisfies = _curry3(function propSatisfies2(pred, name, obj) {
    return pred(obj[name]);
});
var props = _curry2(function props2(ps, obj) {
    return ps.map(function(p) {
        return path([
            p
        ], obj);
    });
});
var range = _curry2(function range2(from, to) {
    if (!(_isNumber(from) && _isNumber(to))) {
        throw new TypeError("Both arguments to range must be numbers");
    }
    var result = [];
    var n = from;
    while(n < to){
        result.push(n);
        n += 1;
    }
    return result;
});
var reduceRight = _curry3(function reduceRight2(fn, acc, list55) {
    var idx = list55.length - 1;
    while(idx >= 0){
        acc = fn(list55[idx], acc);
        idx -= 1;
    }
    return acc;
});
var reduceWhile = _curryN(4, [], function _reduceWhile(pred, fn, a, list56) {
    return _reduce(function(acc, x) {
        return pred(acc, x) ? fn(acc, x) : _reduced(acc);
    }, a, list56);
});
var reduced = _curry1(_reduced);
var times = _curry2(function times2(fn, n) {
    var len = Number(n);
    var idx = 0;
    var list57;
    if (len < 0 || isNaN(len)) {
        throw new RangeError("n must be a non-negative number");
    }
    list57 = new Array(len);
    while(idx < len){
        list57[idx] = fn(idx);
        idx += 1;
    }
    return list57;
});
var repeat = _curry2(function repeat2(value, n) {
    return times(always(value), n);
});
var replace = _curry3(function replace2(regex, replacement, str) {
    return str.replace(regex, replacement);
});
var scan = _curry3(function scan2(fn, acc, list58) {
    var idx = 0;
    var len = list58.length;
    var result = [
        acc
    ];
    while(idx < len){
        acc = fn(acc, list58[idx]);
        result[idx + 1] = acc;
        idx += 1;
    }
    return result;
});
var sequence = _curry2(function sequence2(of2, traversable) {
    return typeof traversable.sequence === "function" ? traversable.sequence(of2) : reduceRight(function(x, acc) {
        return ap(map(prepend, x), acc);
    }, of2([]), traversable);
});
var set1 = _curry3(function set2(lens3, v, x) {
    return over(lens3, always(v), x);
});
var sort = _curry2(function sort2(comparator3, list59) {
    return Array.prototype.slice.call(list59, 0).sort(comparator3);
});
var sortBy = _curry2(function sortBy2(fn, list60) {
    return Array.prototype.slice.call(list60, 0).sort(function(a, b) {
        var aa = fn(a);
        var bb = fn(b);
        return aa < bb ? -1 : aa > bb ? 1 : 0;
    });
});
var sortWith = _curry2(function sortWith2(fns, list61) {
    return Array.prototype.slice.call(list61, 0).sort(function(a, b) {
        var result = 0;
        var i26 = 0;
        while(result === 0 && i26 < fns.length){
            result = fns[i26](a, b);
            i26 += 1;
        }
        return result;
    });
});
var split = invoker(1, "split");
var splitAt = _curry2(function splitAt2(index5, array) {
    return [
        slice(0, index5, array),
        slice(index5, length(array), array)
    ];
});
var splitEvery = _curry2(function splitEvery2(n, list62) {
    if (n <= 0) {
        throw new Error("First argument to splitEvery must be a positive integer");
    }
    var result = [];
    var idx = 0;
    while(idx < list62.length){
        result.push(slice(idx, idx += n, list62));
    }
    return result;
});
var splitWhen = _curry2(function splitWhen2(pred, list63) {
    var idx = 0;
    var len = list63.length;
    var prefix = [];
    while(idx < len && !pred(list63[idx])){
        prefix.push(list63[idx]);
        idx += 1;
    }
    return [
        prefix,
        Array.prototype.slice.call(list63, idx)
    ];
});
var startsWith = _curry2(function(prefix, list64) {
    return equals(take(prefix.length, list64), prefix);
});
var subtract = _curry2(function subtract2(a, b) {
    return Number(a) - Number(b);
});
var symmetricDifference = _curry2(function symmetricDifference2(list1, list2) {
    return concat(difference1(list1, list2), difference1(list2, list1));
});
var symmetricDifferenceWith = _curry3(function symmetricDifferenceWith2(pred, list1, list2) {
    return concat(differenceWith(pred, list1, list2), differenceWith(pred, list2, list1));
});
var takeLastWhile = _curry2(function takeLastWhile2(fn, xs) {
    var idx = xs.length - 1;
    while(idx >= 0 && fn(xs[idx])){
        idx -= 1;
    }
    return slice(idx + 1, Infinity, xs);
});
var XTakeWhile = function() {
    function XTakeWhile2(f, xf) {
        this.xf = xf;
        this.f = f;
    }
    XTakeWhile2.prototype["@@transducer/init"] = _xfBase.init;
    XTakeWhile2.prototype["@@transducer/result"] = _xfBase.result;
    XTakeWhile2.prototype["@@transducer/step"] = function(result, input) {
        return this.f(input) ? this.xf["@@transducer/step"](result, input) : _reduced(result);
    };
    return XTakeWhile2;
}();
var _xtakeWhile = _curry2(function _xtakeWhile2(f, xf) {
    return new XTakeWhile(f, xf);
});
var takeWhile = _curry2(_dispatchable([
    "takeWhile"
], _xtakeWhile, function takeWhile2(fn, xs) {
    var idx = 0;
    var len = xs.length;
    while(idx < len && fn(xs[idx])){
        idx += 1;
    }
    return slice(0, idx, xs);
}));
var XTap = function() {
    function XTap2(f, xf) {
        this.xf = xf;
        this.f = f;
    }
    XTap2.prototype["@@transducer/init"] = _xfBase.init;
    XTap2.prototype["@@transducer/result"] = _xfBase.result;
    XTap2.prototype["@@transducer/step"] = function(result, input) {
        this.f(input);
        return this.xf["@@transducer/step"](result, input);
    };
    return XTap2;
}();
var _xtap = _curry2(function _xtap2(f, xf) {
    return new XTap(f, xf);
});
var tap = _curry2(_dispatchable([], _xtap, function tap2(fn, x) {
    fn(x);
    return x;
}));
function _isRegExp(x) {
    return Object.prototype.toString.call(x) === "[object RegExp]";
}
var test = _curry2(function test2(pattern, str) {
    if (!_isRegExp(pattern)) {
        throw new TypeError("\u2018test\u2019 requires a value of type RegExp as its first argument; received " + toString$1(pattern));
    }
    return _cloneRegExp(pattern).test(str);
});
var andThen = _curry2(function andThen2(f, p) {
    _assertPromise("andThen", p);
    return p.then(f);
});
var toLower = invoker(0, "toLowerCase");
var toPairs = _curry1(function toPairs2(obj) {
    var pairs = [];
    for(var prop3 in obj){
        if (_has(prop3, obj)) {
            pairs[pairs.length] = [
                prop3,
                obj[prop3]
            ];
        }
    }
    return pairs;
});
var toPairsIn = _curry1(function toPairsIn2(obj) {
    var pairs = [];
    for(var prop3 in obj){
        pairs[pairs.length] = [
            prop3,
            obj[prop3]
        ];
    }
    return pairs;
});
var toUpper = invoker(0, "toUpperCase");
var transduce = curryN(4, function transduce2(xf, fn, acc, list65) {
    return _reduce(xf(typeof fn === "function" ? _xwrap(fn) : fn), acc, list65);
});
var transpose = _curry1(function transpose2(outerlist) {
    var i27 = 0;
    var result = [];
    while(i27 < outerlist.length){
        var innerlist = outerlist[i27];
        var j = 0;
        while(j < innerlist.length){
            if (typeof result[j] === "undefined") {
                result[j] = [];
            }
            result[j].push(innerlist[j]);
            j += 1;
        }
        i27 += 1;
    }
    return result;
});
var traverse = _curry3(function traverse2(of2, f, traversable) {
    return typeof traversable["fantasy-land/traverse"] === "function" ? traversable["fantasy-land/traverse"](f, of2) : sequence(of2, map(f, traversable));
});
var ws = "	\n\v\f\r \xA0\u1680\u180E\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000\u2028\u2029\uFEFF";
var zeroWidth = "\u200B";
var hasProtoTrim = typeof String.prototype.trim === "function";
var trim = !hasProtoTrim || ws.trim() || !zeroWidth.trim() ? _curry1(function trim2(str) {
    var beginRx = new RegExp("^[" + ws + "][" + ws + "]*");
    var endRx = new RegExp("[" + ws + "][" + ws + "]*$");
    return str.replace(beginRx, "").replace(endRx, "");
}) : _curry1(function trim3(str) {
    return str.trim();
});
var tryCatch = _curry2(function _tryCatch(tryer, catcher) {
    return _arity(tryer.length, function() {
        try {
            return tryer.apply(this, arguments);
        } catch (e) {
            return catcher.apply(this, _concat([
                e
            ], arguments));
        }
    });
});
var unapply = _curry1(function unapply2(fn) {
    return function() {
        return fn(Array.prototype.slice.call(arguments, 0));
    };
});
var unary = _curry1(function unary2(fn) {
    return nAry(1, fn);
});
var uncurryN = _curry2(function uncurryN2(depth, fn) {
    return curryN(depth, function() {
        var currentDepth = 1;
        var value = fn;
        var idx = 0;
        var endIdx;
        while(currentDepth <= depth && typeof value === "function"){
            endIdx = currentDepth === depth ? arguments.length : idx + value.length;
            value = value.apply(this, Array.prototype.slice.call(arguments, idx, endIdx));
            currentDepth += 1;
            idx = endIdx;
        }
        return value;
    });
});
var unfold = _curry2(function unfold2(fn, seed) {
    var pair3 = fn(seed);
    var result = [];
    while(pair3 && pair3.length){
        result[result.length] = pair3[0];
        pair3 = fn(pair3[1]);
    }
    return result;
});
var union = _curry2(compose(uniq1, _concat));
var uniqWith = _curry2(function uniqWith2(pred, list66) {
    var idx = 0;
    var len = list66.length;
    var result = [];
    var item;
    while(idx < len){
        item = list66[idx];
        if (!_includesWith(pred, item, result)) {
            result[result.length] = item;
        }
        idx += 1;
    }
    return result;
});
var unionWith = _curry3(function unionWith2(pred, list1, list2) {
    return uniqWith(pred, _concat(list1, list2));
});
var unless = _curry3(function unless2(pred, whenFalseFn, x) {
    return pred(x) ? x : whenFalseFn(x);
});
var unnest = chain(_identity);
var until = _curry3(function until2(pred, fn, init2) {
    var val = init2;
    while(!pred(val)){
        val = fn(val);
    }
    return val;
});
var valuesIn = _curry1(function valuesIn2(obj) {
    var prop3;
    var vs = [];
    for(prop3 in obj){
        vs[vs.length] = obj[prop3];
    }
    return vs;
});
var Const = function(x) {
    return {
        value: x,
        "fantasy-land/map": function() {
            return this;
        }
    };
};
var view = _curry2(function view2(lens3, x) {
    return lens3(Const)(x).value;
});
var when = _curry3(function when2(pred, whenTrueFn, x) {
    return pred(x) ? whenTrueFn(x) : x;
});
var where = _curry2(function where2(spec, testObj) {
    for(var prop3 in spec){
        if (_has(prop3, spec) && !spec[prop3](testObj[prop3])) {
            return false;
        }
    }
    return true;
});
var whereEq = _curry2(function whereEq2(spec, testObj) {
    return where(map(equals, spec), testObj);
});
var without = _curry2(function(xs, list67) {
    return reject(flip(_includes)(xs), list67);
});
var xor = _curry2(function xor2(a, b) {
    return Boolean(!a ^ !b);
});
var xprod = _curry2(function xprod2(a, b) {
    var idx = 0;
    var ilen = a.length;
    var j;
    var jlen = b.length;
    var result = [];
    while(idx < ilen){
        j = 0;
        while(j < jlen){
            result[result.length] = [
                a[idx],
                b[j]
            ];
            j += 1;
        }
        idx += 1;
    }
    return result;
});
var zip = _curry2(function zip2(a, b) {
    var rv = [];
    var idx = 0;
    var len = Math.min(a.length, b.length);
    while(idx < len){
        rv[idx] = [
            a[idx],
            b[idx]
        ];
        idx += 1;
    }
    return rv;
});
var zipObj = _curry2(function zipObj2(keys4, values3) {
    var idx = 0;
    var len = Math.min(keys4.length, values3.length);
    var out = {};
    while(idx < len){
        out[keys4[idx]] = values3[idx];
        idx += 1;
    }
    return out;
});
var zipWith = _curry3(function zipWith2(fn, a, b) {
    var rv = [];
    var idx = 0;
    var len = Math.min(a.length, b.length);
    while(idx < len){
        rv[idx] = fn(a[idx], b[idx]);
        idx += 1;
    }
    return rv;
});
var thunkify = _curry1(function thunkify2(fn) {
    return curryN(fn.length, function createThunk() {
        var fnArgs = arguments;
        return function invokeThunk() {
            return fn.apply(this, fnArgs);
        };
    });
});
const mod = function() {
    return {
        default: null,
        F,
        T,
        __,
        add: add2,
        addIndex,
        adjust,
        all,
        allPass,
        always,
        and,
        andThen,
        any,
        anyPass,
        ap,
        aperture,
        append,
        apply,
        applySpec,
        applyTo,
        ascend,
        assoc,
        assocPath,
        binary,
        bind,
        both,
        call,
        chain,
        clamp,
        clone,
        comparator,
        complement,
        compose,
        composeK,
        composeP,
        composeWith,
        concat,
        cond,
        construct,
        constructN,
        contains: contains$1,
        converge,
        countBy,
        curry,
        curryN,
        dec,
        defaultTo,
        descend,
        difference: difference1,
        differenceWith,
        dissoc,
        dissocPath,
        divide,
        drop,
        dropLast: dropLast$1,
        dropLastWhile: dropLastWhile$1,
        dropRepeats,
        dropRepeatsWith,
        dropWhile,
        either,
        empty,
        endsWith,
        eqBy,
        eqProps,
        equals,
        evolve,
        filter,
        find: find1,
        findIndex,
        findLast,
        findLastIndex,
        flatten,
        flip,
        forEach,
        forEachObjIndexed,
        fromPairs,
        groupBy,
        groupWith,
        gt,
        gte,
        has,
        hasIn,
        hasPath,
        head,
        identical,
        identity,
        ifElse,
        inc,
        includes,
        indexBy,
        indexOf,
        init,
        innerJoin,
        insert,
        insertAll,
        intersection,
        intersperse,
        into,
        invert,
        invertObj,
        invoker,
        is,
        isEmpty,
        isNil,
        join: join1,
        juxt,
        keys,
        keysIn,
        last,
        lastIndexOf,
        length,
        lens,
        lensIndex,
        lensPath,
        lensProp,
        lift,
        liftN,
        lt,
        lte,
        map,
        mapAccum,
        mapAccumRight,
        mapObjIndexed,
        match,
        mathMod,
        max,
        maxBy,
        mean,
        median,
        memoizeWith,
        merge,
        mergeAll,
        mergeDeepLeft,
        mergeDeepRight,
        mergeDeepWith,
        mergeDeepWithKey,
        mergeLeft,
        mergeRight,
        mergeWith,
        mergeWithKey,
        min,
        minBy,
        modulo,
        move,
        multiply,
        nAry,
        negate,
        none,
        not,
        nth,
        nthArg,
        o,
        objOf,
        of,
        omit,
        once,
        or,
        otherwise,
        over,
        pair,
        partial,
        partialRight,
        partition,
        path,
        pathEq,
        pathOr,
        pathSatisfies,
        paths,
        pick,
        pickAll,
        pickBy,
        pipe,
        pipeK,
        pipeP,
        pipeWith,
        pluck,
        prepend,
        product,
        project,
        prop,
        propEq,
        propIs,
        propOr,
        propSatisfies,
        props,
        range,
        reduce,
        reduceBy,
        reduceRight,
        reduceWhile,
        reduced,
        reject,
        remove: remove2,
        repeat,
        replace,
        reverse,
        scan,
        sequence,
        set: set1,
        slice,
        sort,
        sortBy,
        sortWith,
        split,
        splitAt,
        splitEvery,
        splitWhen,
        startsWith,
        subtract,
        sum,
        symmetricDifference,
        symmetricDifferenceWith,
        tail,
        take,
        takeLast,
        takeLastWhile,
        takeWhile,
        tap,
        test,
        thunkify,
        times,
        toLower,
        toPairs,
        toPairsIn,
        toString: toString$1,
        toUpper,
        transduce,
        transpose,
        traverse,
        trim,
        tryCatch,
        type,
        unapply,
        unary,
        uncurryN,
        unfold,
        union,
        unionWith,
        uniq: uniq1,
        uniqBy,
        uniqWith,
        unless,
        unnest,
        until,
        update: update1,
        useWith,
        values,
        valuesIn,
        view,
        when,
        where,
        whereEq,
        without,
        xor,
        xprod,
        zip,
        zipObj,
        zipWith
    };
}();
const base64abc = [
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "H",
    "I",
    "J",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
    "Q",
    "R",
    "S",
    "T",
    "U",
    "V",
    "W",
    "X",
    "Y",
    "Z",
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
    "n",
    "o",
    "p",
    "q",
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "z",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "+",
    "/"
];
function encode(data) {
    const uint8 = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    let result = "", i28;
    const l7 = uint8.length;
    for(i28 = 2; i28 < l7; i28 += 3){
        result += base64abc[uint8[i28 - 2] >> 2];
        result += base64abc[(uint8[i28 - 2] & 3) << 4 | uint8[i28 - 1] >> 4];
        result += base64abc[(uint8[i28 - 1] & 15) << 2 | uint8[i28] >> 6];
        result += base64abc[uint8[i28] & 63];
    }
    if (i28 === l7 + 1) {
        result += base64abc[uint8[i28 - 2] >> 2];
        result += base64abc[(uint8[i28 - 2] & 3) << 4];
        result += "==";
    }
    if (i28 === l7) {
        result += base64abc[uint8[i28 - 2] >> 2];
        result += base64abc[(uint8[i28 - 2] & 3) << 4 | uint8[i28 - 1] >> 4];
        result += base64abc[(uint8[i28 - 1] & 15) << 2];
        result += "=";
    }
    return result;
}
function decode(b64) {
    const binString = atob(b64);
    const size = binString.length;
    const bytes = new Uint8Array(size);
    for(let i29 = 0; i29 < size; i29++){
        bytes[i29] = binString.charCodeAt(i29);
    }
    return bytes;
}
function addPaddingToBase64url(base64url) {
    if (base64url.length % 4 === 2) return base64url + "==";
    if (base64url.length % 4 === 3) return base64url + "=";
    if (base64url.length % 4 === 1) {
        throw new TypeError("Illegal base64url string!");
    }
    return base64url;
}
function convertBase64urlToBase64(b64url) {
    return addPaddingToBase64url(b64url).replace(/\-/g, "+").replace(/_/g, "/");
}
function convertBase64ToBase64url(b64) {
    return b64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function encode1(uint8) {
    return convertBase64ToBase64url(encode(uint8));
}
function decode1(b64url) {
    return decode(convertBase64urlToBase64(b64url));
}
const mod1 = {
    addPaddingToBase64url: addPaddingToBase64url,
    encode: encode1,
    decode: decode1
};
new TextEncoder().encode("0123456789abcdef");
function errInvalidByte(__byte) {
    return new Error("encoding/hex: invalid byte: " + new TextDecoder().decode(new Uint8Array([
        __byte
    ])));
}
function errLength() {
    return new Error("encoding/hex: odd length hex string");
}
function fromHexChar(__byte) {
    if (48 <= __byte && __byte <= 57) return __byte - 48;
    if (97 <= __byte && __byte <= 102) return __byte - 97 + 10;
    if (65 <= __byte && __byte <= 70) return __byte - 65 + 10;
    throw errInvalidByte(__byte);
}
function decode2(src) {
    const dst = new Uint8Array(decodedLen(src.length));
    for(let i30 = 0; i30 < dst.length; i30++){
        const a = fromHexChar(src[i30 * 2]);
        const b = fromHexChar(src[i30 * 2 + 1]);
        dst[i30] = a << 4 | b;
    }
    if (src.length % 2 == 1) {
        fromHexChar(src[dst.length * 2]);
        throw errLength();
    }
    return dst;
}
function decodedLen(x) {
    return x >>> 1;
}
function decodeString(s) {
    return decode2(new TextEncoder().encode(s));
}
const HEX_CHARS = "0123456789abcdef".split("");
const EXTRA = [
    -2147483648,
    8388608,
    32768,
    128
];
const SHIFT = [
    24,
    16,
    8,
    0
];
const K = [
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298, 
];
const blocks = [];
class Sha256 {
    #block;
    #blocks;
    #bytes;
    #finalized;
    #first;
    #h0;
    #h1;
    #h2;
    #h3;
    #h4;
    #h5;
    #h6;
    #h7;
    #hashed;
    #hBytes;
    #is224;
    #lastByteIndex = 0;
    #start;
    constructor(is224 = false, sharedMemory = false){
        this.init(is224, sharedMemory);
    }
    init(is224, sharedMemory) {
        if (sharedMemory) {
            blocks[0] = blocks[16] = blocks[1] = blocks[2] = blocks[3] = blocks[4] = blocks[5] = blocks[6] = blocks[7] = blocks[8] = blocks[9] = blocks[10] = blocks[11] = blocks[12] = blocks[13] = blocks[14] = blocks[15] = 0;
            this.#blocks = blocks;
        } else {
            this.#blocks = [
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0
            ];
        }
        if (is224) {
            this.#h0 = 3238371032;
            this.#h1 = 914150663;
            this.#h2 = 812702999;
            this.#h3 = 4144912697;
            this.#h4 = 4290775857;
            this.#h5 = 1750603025;
            this.#h6 = 1694076839;
            this.#h7 = 3204075428;
        } else {
            this.#h0 = 1779033703;
            this.#h1 = 3144134277;
            this.#h2 = 1013904242;
            this.#h3 = 2773480762;
            this.#h4 = 1359893119;
            this.#h5 = 2600822924;
            this.#h6 = 528734635;
            this.#h7 = 1541459225;
        }
        this.#block = this.#start = this.#bytes = this.#hBytes = 0;
        this.#finalized = this.#hashed = false;
        this.#first = true;
        this.#is224 = is224;
    }
    update(message) {
        if (this.#finalized) {
            return this;
        }
        let msg;
        if (message instanceof ArrayBuffer) {
            msg = new Uint8Array(message);
        } else {
            msg = message;
        }
        let index6 = 0;
        const length3 = msg.length;
        const blocks1 = this.#blocks;
        while(index6 < length3){
            let i31;
            if (this.#hashed) {
                this.#hashed = false;
                blocks1[0] = this.#block;
                blocks1[16] = blocks1[1] = blocks1[2] = blocks1[3] = blocks1[4] = blocks1[5] = blocks1[6] = blocks1[7] = blocks1[8] = blocks1[9] = blocks1[10] = blocks1[11] = blocks1[12] = blocks1[13] = blocks1[14] = blocks1[15] = 0;
            }
            if (typeof msg !== "string") {
                for(i31 = this.#start; index6 < length3 && i31 < 64; ++index6){
                    blocks1[i31 >> 2] |= msg[index6] << SHIFT[(i31++) & 3];
                }
            } else {
                for(i31 = this.#start; index6 < length3 && i31 < 64; ++index6){
                    let code13 = msg.charCodeAt(index6);
                    if (code13 < 128) {
                        blocks1[i31 >> 2] |= code13 << SHIFT[(i31++) & 3];
                    } else if (code13 < 2048) {
                        blocks1[i31 >> 2] |= (192 | code13 >> 6) << SHIFT[(i31++) & 3];
                        blocks1[i31 >> 2] |= (128 | code13 & 63) << SHIFT[(i31++) & 3];
                    } else if (code13 < 55296 || code13 >= 57344) {
                        blocks1[i31 >> 2] |= (224 | code13 >> 12) << SHIFT[(i31++) & 3];
                        blocks1[i31 >> 2] |= (128 | code13 >> 6 & 63) << SHIFT[(i31++) & 3];
                        blocks1[i31 >> 2] |= (128 | code13 & 63) << SHIFT[(i31++) & 3];
                    } else {
                        code13 = 65536 + ((code13 & 1023) << 10 | msg.charCodeAt(++index6) & 1023);
                        blocks1[i31 >> 2] |= (240 | code13 >> 18) << SHIFT[(i31++) & 3];
                        blocks1[i31 >> 2] |= (128 | code13 >> 12 & 63) << SHIFT[(i31++) & 3];
                        blocks1[i31 >> 2] |= (128 | code13 >> 6 & 63) << SHIFT[(i31++) & 3];
                        blocks1[i31 >> 2] |= (128 | code13 & 63) << SHIFT[(i31++) & 3];
                    }
                }
            }
            this.#lastByteIndex = i31;
            this.#bytes += i31 - this.#start;
            if (i31 >= 64) {
                this.#block = blocks1[16];
                this.#start = i31 - 64;
                this.hash();
                this.#hashed = true;
            } else {
                this.#start = i31;
            }
        }
        if (this.#bytes > 4294967295) {
            this.#hBytes += this.#bytes / 4294967296 << 0;
            this.#bytes = this.#bytes % 4294967296;
        }
        return this;
    }
    finalize() {
        if (this.#finalized) {
            return;
        }
        this.#finalized = true;
        const blocks2 = this.#blocks;
        const i32 = this.#lastByteIndex;
        blocks2[16] = this.#block;
        blocks2[i32 >> 2] |= EXTRA[i32 & 3];
        this.#block = blocks2[16];
        if (i32 >= 56) {
            if (!this.#hashed) {
                this.hash();
            }
            blocks2[0] = this.#block;
            blocks2[16] = blocks2[1] = blocks2[2] = blocks2[3] = blocks2[4] = blocks2[5] = blocks2[6] = blocks2[7] = blocks2[8] = blocks2[9] = blocks2[10] = blocks2[11] = blocks2[12] = blocks2[13] = blocks2[14] = blocks2[15] = 0;
        }
        blocks2[14] = this.#hBytes << 3 | this.#bytes >>> 29;
        blocks2[15] = this.#bytes << 3;
        this.hash();
    }
    hash() {
        let a = this.#h0;
        let b = this.#h1;
        let c = this.#h2;
        let d = this.#h3;
        let e = this.#h4;
        let f = this.#h5;
        let g = this.#h6;
        let h = this.#h7;
        const blocks3 = this.#blocks;
        let s0;
        let s1;
        let maj;
        let t1;
        let t2;
        let ch;
        let ab;
        let da;
        let cd;
        let bc;
        for(let j = 16; j < 64; ++j){
            t1 = blocks3[j - 15];
            s0 = (t1 >>> 7 | t1 << 25) ^ (t1 >>> 18 | t1 << 14) ^ t1 >>> 3;
            t1 = blocks3[j - 2];
            s1 = (t1 >>> 17 | t1 << 15) ^ (t1 >>> 19 | t1 << 13) ^ t1 >>> 10;
            blocks3[j] = blocks3[j - 16] + s0 + blocks3[j - 7] + s1 << 0;
        }
        bc = b & c;
        for(let j1 = 0; j1 < 64; j1 += 4){
            if (this.#first) {
                if (this.#is224) {
                    ab = 300032;
                    t1 = blocks3[0] - 1413257819;
                    h = t1 - 150054599 << 0;
                    d = t1 + 24177077 << 0;
                } else {
                    ab = 704751109;
                    t1 = blocks3[0] - 210244248;
                    h = t1 - 1521486534 << 0;
                    d = t1 + 143694565 << 0;
                }
                this.#first = false;
            } else {
                s0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
                s1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
                ab = a & b;
                maj = ab ^ a & c ^ bc;
                ch = e & f ^ ~e & g;
                t1 = h + s1 + ch + K[j1] + blocks3[j1];
                t2 = s0 + maj;
                h = d + t1 << 0;
                d = t1 + t2 << 0;
            }
            s0 = (d >>> 2 | d << 30) ^ (d >>> 13 | d << 19) ^ (d >>> 22 | d << 10);
            s1 = (h >>> 6 | h << 26) ^ (h >>> 11 | h << 21) ^ (h >>> 25 | h << 7);
            da = d & a;
            maj = da ^ d & b ^ ab;
            ch = h & e ^ ~h & f;
            t1 = g + s1 + ch + K[j1 + 1] + blocks3[j1 + 1];
            t2 = s0 + maj;
            g = c + t1 << 0;
            c = t1 + t2 << 0;
            s0 = (c >>> 2 | c << 30) ^ (c >>> 13 | c << 19) ^ (c >>> 22 | c << 10);
            s1 = (g >>> 6 | g << 26) ^ (g >>> 11 | g << 21) ^ (g >>> 25 | g << 7);
            cd = c & d;
            maj = cd ^ c & a ^ da;
            ch = g & h ^ ~g & e;
            t1 = f + s1 + ch + K[j1 + 2] + blocks3[j1 + 2];
            t2 = s0 + maj;
            f = b + t1 << 0;
            b = t1 + t2 << 0;
            s0 = (b >>> 2 | b << 30) ^ (b >>> 13 | b << 19) ^ (b >>> 22 | b << 10);
            s1 = (f >>> 6 | f << 26) ^ (f >>> 11 | f << 21) ^ (f >>> 25 | f << 7);
            bc = b & c;
            maj = bc ^ b & d ^ cd;
            ch = f & g ^ ~f & h;
            t1 = e + s1 + ch + K[j1 + 3] + blocks3[j1 + 3];
            t2 = s0 + maj;
            e = a + t1 << 0;
            a = t1 + t2 << 0;
        }
        this.#h0 = this.#h0 + a << 0;
        this.#h1 = this.#h1 + b << 0;
        this.#h2 = this.#h2 + c << 0;
        this.#h3 = this.#h3 + d << 0;
        this.#h4 = this.#h4 + e << 0;
        this.#h5 = this.#h5 + f << 0;
        this.#h6 = this.#h6 + g << 0;
        this.#h7 = this.#h7 + h << 0;
    }
    hex() {
        this.finalize();
        const h0 = this.#h0;
        const h1 = this.#h1;
        const h2 = this.#h2;
        const h3 = this.#h3;
        const h4 = this.#h4;
        const h5 = this.#h5;
        const h6 = this.#h6;
        const h7 = this.#h7;
        let hex = HEX_CHARS[h0 >> 28 & 15] + HEX_CHARS[h0 >> 24 & 15] + HEX_CHARS[h0 >> 20 & 15] + HEX_CHARS[h0 >> 16 & 15] + HEX_CHARS[h0 >> 12 & 15] + HEX_CHARS[h0 >> 8 & 15] + HEX_CHARS[h0 >> 4 & 15] + HEX_CHARS[h0 & 15] + HEX_CHARS[h1 >> 28 & 15] + HEX_CHARS[h1 >> 24 & 15] + HEX_CHARS[h1 >> 20 & 15] + HEX_CHARS[h1 >> 16 & 15] + HEX_CHARS[h1 >> 12 & 15] + HEX_CHARS[h1 >> 8 & 15] + HEX_CHARS[h1 >> 4 & 15] + HEX_CHARS[h1 & 15] + HEX_CHARS[h2 >> 28 & 15] + HEX_CHARS[h2 >> 24 & 15] + HEX_CHARS[h2 >> 20 & 15] + HEX_CHARS[h2 >> 16 & 15] + HEX_CHARS[h2 >> 12 & 15] + HEX_CHARS[h2 >> 8 & 15] + HEX_CHARS[h2 >> 4 & 15] + HEX_CHARS[h2 & 15] + HEX_CHARS[h3 >> 28 & 15] + HEX_CHARS[h3 >> 24 & 15] + HEX_CHARS[h3 >> 20 & 15] + HEX_CHARS[h3 >> 16 & 15] + HEX_CHARS[h3 >> 12 & 15] + HEX_CHARS[h3 >> 8 & 15] + HEX_CHARS[h3 >> 4 & 15] + HEX_CHARS[h3 & 15] + HEX_CHARS[h4 >> 28 & 15] + HEX_CHARS[h4 >> 24 & 15] + HEX_CHARS[h4 >> 20 & 15] + HEX_CHARS[h4 >> 16 & 15] + HEX_CHARS[h4 >> 12 & 15] + HEX_CHARS[h4 >> 8 & 15] + HEX_CHARS[h4 >> 4 & 15] + HEX_CHARS[h4 & 15] + HEX_CHARS[h5 >> 28 & 15] + HEX_CHARS[h5 >> 24 & 15] + HEX_CHARS[h5 >> 20 & 15] + HEX_CHARS[h5 >> 16 & 15] + HEX_CHARS[h5 >> 12 & 15] + HEX_CHARS[h5 >> 8 & 15] + HEX_CHARS[h5 >> 4 & 15] + HEX_CHARS[h5 & 15] + HEX_CHARS[h6 >> 28 & 15] + HEX_CHARS[h6 >> 24 & 15] + HEX_CHARS[h6 >> 20 & 15] + HEX_CHARS[h6 >> 16 & 15] + HEX_CHARS[h6 >> 12 & 15] + HEX_CHARS[h6 >> 8 & 15] + HEX_CHARS[h6 >> 4 & 15] + HEX_CHARS[h6 & 15];
        if (!this.#is224) {
            hex += HEX_CHARS[h7 >> 28 & 15] + HEX_CHARS[h7 >> 24 & 15] + HEX_CHARS[h7 >> 20 & 15] + HEX_CHARS[h7 >> 16 & 15] + HEX_CHARS[h7 >> 12 & 15] + HEX_CHARS[h7 >> 8 & 15] + HEX_CHARS[h7 >> 4 & 15] + HEX_CHARS[h7 & 15];
        }
        return hex;
    }
    toString() {
        return this.hex();
    }
    digest() {
        this.finalize();
        const h0 = this.#h0;
        const h1 = this.#h1;
        const h2 = this.#h2;
        const h3 = this.#h3;
        const h4 = this.#h4;
        const h5 = this.#h5;
        const h6 = this.#h6;
        const h7 = this.#h7;
        const arr = [
            h0 >> 24 & 255,
            h0 >> 16 & 255,
            h0 >> 8 & 255,
            h0 & 255,
            h1 >> 24 & 255,
            h1 >> 16 & 255,
            h1 >> 8 & 255,
            h1 & 255,
            h2 >> 24 & 255,
            h2 >> 16 & 255,
            h2 >> 8 & 255,
            h2 & 255,
            h3 >> 24 & 255,
            h3 >> 16 & 255,
            h3 >> 8 & 255,
            h3 & 255,
            h4 >> 24 & 255,
            h4 >> 16 & 255,
            h4 >> 8 & 255,
            h4 & 255,
            h5 >> 24 & 255,
            h5 >> 16 & 255,
            h5 >> 8 & 255,
            h5 & 255,
            h6 >> 24 & 255,
            h6 >> 16 & 255,
            h6 >> 8 & 255,
            h6 & 255, 
        ];
        if (!this.#is224) {
            arr.push(h7 >> 24 & 255, h7 >> 16 & 255, h7 >> 8 & 255, h7 & 255);
        }
        return arr;
    }
    array() {
        return this.digest();
    }
    arrayBuffer() {
        this.finalize();
        const buffer = new ArrayBuffer(this.#is224 ? 28 : 32);
        const dataView = new DataView(buffer);
        dataView.setUint32(0, this.#h0);
        dataView.setUint32(4, this.#h1);
        dataView.setUint32(8, this.#h2);
        dataView.setUint32(12, this.#h3);
        dataView.setUint32(16, this.#h4);
        dataView.setUint32(20, this.#h5);
        dataView.setUint32(24, this.#h6);
        if (!this.#is224) {
            dataView.setUint32(28, this.#h7);
        }
        return buffer;
    }
}
class HmacSha256 extends Sha256 {
    #inner;
    #is224;
    #oKeyPad;
    #sharedMemory;
    constructor(secretKey, is224 = false, sharedMemory = false){
        super(is224, sharedMemory);
        let key;
        if (typeof secretKey === "string") {
            const bytes = [];
            const length4 = secretKey.length;
            let index = 0;
            for(let i33 = 0; i33 < length4; ++i33){
                let code14 = secretKey.charCodeAt(i33);
                if (code14 < 128) {
                    bytes[index++] = code14;
                } else if (code14 < 2048) {
                    bytes[index++] = 192 | code14 >> 6;
                    bytes[index++] = 128 | code14 & 63;
                } else if (code14 < 55296 || code14 >= 57344) {
                    bytes[index++] = 224 | code14 >> 12;
                    bytes[index++] = 128 | code14 >> 6 & 63;
                    bytes[index++] = 128 | code14 & 63;
                } else {
                    code14 = 65536 + ((code14 & 1023) << 10 | secretKey.charCodeAt(++i33) & 1023);
                    bytes[index++] = 240 | code14 >> 18;
                    bytes[index++] = 128 | code14 >> 12 & 63;
                    bytes[index++] = 128 | code14 >> 6 & 63;
                    bytes[index++] = 128 | code14 & 63;
                }
            }
            key = bytes;
        } else {
            if (secretKey instanceof ArrayBuffer) {
                key = new Uint8Array(secretKey);
            } else {
                key = secretKey;
            }
        }
        if (key.length > 64) {
            key = new Sha256(is224, true).update(key).array();
        }
        const oKeyPad = [];
        const iKeyPad = [];
        for(let i34 = 0; i34 < 64; ++i34){
            const b = key[i34] || 0;
            oKeyPad[i34] = 92 ^ b;
            iKeyPad[i34] = 54 ^ b;
        }
        this.update(iKeyPad);
        this.#oKeyPad = oKeyPad;
        this.#inner = true;
        this.#is224 = is224;
        this.#sharedMemory = sharedMemory;
    }
    finalize() {
        super.finalize();
        if (this.#inner) {
            this.#inner = false;
            const innerHash = this.array();
            super.init(this.#is224, this.#sharedMemory);
            this.update(this.#oKeyPad);
            this.update(innerHash);
            super.finalize();
        }
    }
}
const HEX_CHARS1 = [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "a",
    "b",
    "c",
    "d",
    "e",
    "f"
];
const EXTRA1 = [
    -2147483648,
    8388608,
    32768,
    128
];
const SHIFT1 = [
    24,
    16,
    8,
    0
];
const K1 = [
    1116352408,
    3609767458,
    1899447441,
    602891725,
    3049323471,
    3964484399,
    3921009573,
    2173295548,
    961987163,
    4081628472,
    1508970993,
    3053834265,
    2453635748,
    2937671579,
    2870763221,
    3664609560,
    3624381080,
    2734883394,
    310598401,
    1164996542,
    607225278,
    1323610764,
    1426881987,
    3590304994,
    1925078388,
    4068182383,
    2162078206,
    991336113,
    2614888103,
    633803317,
    3248222580,
    3479774868,
    3835390401,
    2666613458,
    4022224774,
    944711139,
    264347078,
    2341262773,
    604807628,
    2007800933,
    770255983,
    1495990901,
    1249150122,
    1856431235,
    1555081692,
    3175218132,
    1996064986,
    2198950837,
    2554220882,
    3999719339,
    2821834349,
    766784016,
    2952996808,
    2566594879,
    3210313671,
    3203337956,
    3336571891,
    1034457026,
    3584528711,
    2466948901,
    113926993,
    3758326383,
    338241895,
    168717936,
    666307205,
    1188179964,
    773529912,
    1546045734,
    1294757372,
    1522805485,
    1396182291,
    2643833823,
    1695183700,
    2343527390,
    1986661051,
    1014477480,
    2177026350,
    1206759142,
    2456956037,
    344077627,
    2730485921,
    1290863460,
    2820302411,
    3158454273,
    3259730800,
    3505952657,
    3345764771,
    106217008,
    3516065817,
    3606008344,
    3600352804,
    1432725776,
    4094571909,
    1467031594,
    275423344,
    851169720,
    430227734,
    3100823752,
    506948616,
    1363258195,
    659060556,
    3750685593,
    883997877,
    3785050280,
    958139571,
    3318307427,
    1322822218,
    3812723403,
    1537002063,
    2003034995,
    1747873779,
    3602036899,
    1955562222,
    1575990012,
    2024104815,
    1125592928,
    2227730452,
    2716904306,
    2361852424,
    442776044,
    2428436474,
    593698344,
    2756734187,
    3733110249,
    3204031479,
    2999351573,
    3329325298,
    3815920427,
    3391569614,
    3928383900,
    3515267271,
    566280711,
    3940187606,
    3454069534,
    4118630271,
    4000239992,
    116418474,
    1914138554,
    174292421,
    2731055270,
    289380356,
    3203993006,
    460393269,
    320620315,
    685471733,
    587496836,
    852142971,
    1086792851,
    1017036298,
    365543100,
    1126000580,
    2618297676,
    1288033470,
    3409855158,
    1501505948,
    4234509866,
    1607167915,
    987167468,
    1816402316,
    1246189591
];
const blocks1 = [];
class Sha512 {
    #blocks;
    #block;
    #bits;
    #start;
    #bytes;
    #hBytes;
    #lastByteIndex = 0;
    #finalized;
    #hashed;
    #h0h;
    #h0l;
    #h1h;
    #h1l;
    #h2h;
    #h2l;
    #h3h;
    #h3l;
    #h4h;
    #h4l;
    #h5h;
    #h5l;
    #h6h;
    #h6l;
    #h7h;
    #h7l;
    constructor(bits = 512, sharedMemory = false){
        this.init(bits, sharedMemory);
    }
    init(bits, sharedMemory) {
        if (sharedMemory) {
            blocks1[0] = blocks1[1] = blocks1[2] = blocks1[3] = blocks1[4] = blocks1[5] = blocks1[6] = blocks1[7] = blocks1[8] = blocks1[9] = blocks1[10] = blocks1[11] = blocks1[12] = blocks1[13] = blocks1[14] = blocks1[15] = blocks1[16] = blocks1[17] = blocks1[18] = blocks1[19] = blocks1[20] = blocks1[21] = blocks1[22] = blocks1[23] = blocks1[24] = blocks1[25] = blocks1[26] = blocks1[27] = blocks1[28] = blocks1[29] = blocks1[30] = blocks1[31] = blocks1[32] = 0;
            this.#blocks = blocks1;
        } else {
            this.#blocks = [
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0
            ];
        }
        if (bits === 224) {
            this.#h0h = 2352822216;
            this.#h0l = 424955298;
            this.#h1h = 1944164710;
            this.#h1l = 2312950998;
            this.#h2h = 502970286;
            this.#h2l = 855612546;
            this.#h3h = 1738396948;
            this.#h3l = 1479516111;
            this.#h4h = 258812777;
            this.#h4l = 2077511080;
            this.#h5h = 2011393907;
            this.#h5l = 79989058;
            this.#h6h = 1067287976;
            this.#h6l = 1780299464;
            this.#h7h = 286451373;
            this.#h7l = 2446758561;
        } else if (bits === 256) {
            this.#h0h = 573645204;
            this.#h0l = 4230739756;
            this.#h1h = 2673172387;
            this.#h1l = 3360449730;
            this.#h2h = 596883563;
            this.#h2l = 1867755857;
            this.#h3h = 2520282905;
            this.#h3l = 1497426621;
            this.#h4h = 2519219938;
            this.#h4l = 2827943907;
            this.#h5h = 3193839141;
            this.#h5l = 1401305490;
            this.#h6h = 721525244;
            this.#h6l = 746961066;
            this.#h7h = 246885852;
            this.#h7l = 2177182882;
        } else if (bits === 384) {
            this.#h0h = 3418070365;
            this.#h0l = 3238371032;
            this.#h1h = 1654270250;
            this.#h1l = 914150663;
            this.#h2h = 2438529370;
            this.#h2l = 812702999;
            this.#h3h = 355462360;
            this.#h3l = 4144912697;
            this.#h4h = 1731405415;
            this.#h4l = 4290775857;
            this.#h5h = 2394180231;
            this.#h5l = 1750603025;
            this.#h6h = 3675008525;
            this.#h6l = 1694076839;
            this.#h7h = 1203062813;
            this.#h7l = 3204075428;
        } else {
            this.#h0h = 1779033703;
            this.#h0l = 4089235720;
            this.#h1h = 3144134277;
            this.#h1l = 2227873595;
            this.#h2h = 1013904242;
            this.#h2l = 4271175723;
            this.#h3h = 2773480762;
            this.#h3l = 1595750129;
            this.#h4h = 1359893119;
            this.#h4l = 2917565137;
            this.#h5h = 2600822924;
            this.#h5l = 725511199;
            this.#h6h = 528734635;
            this.#h6l = 4215389547;
            this.#h7h = 1541459225;
            this.#h7l = 327033209;
        }
        this.#bits = bits;
        this.#block = this.#start = this.#bytes = this.#hBytes = 0;
        this.#finalized = this.#hashed = false;
    }
    update(message) {
        if (this.#finalized) {
            return this;
        }
        let msg;
        if (message instanceof ArrayBuffer) {
            msg = new Uint8Array(message);
        } else {
            msg = message;
        }
        const length5 = msg.length;
        const blocks11 = this.#blocks;
        let index7 = 0;
        while(index7 < length5){
            let i35;
            if (this.#hashed) {
                this.#hashed = false;
                blocks11[0] = this.#block;
                blocks11[1] = blocks11[2] = blocks11[3] = blocks11[4] = blocks11[5] = blocks11[6] = blocks11[7] = blocks11[8] = blocks11[9] = blocks11[10] = blocks11[11] = blocks11[12] = blocks11[13] = blocks11[14] = blocks11[15] = blocks11[16] = blocks11[17] = blocks11[18] = blocks11[19] = blocks11[20] = blocks11[21] = blocks11[22] = blocks11[23] = blocks11[24] = blocks11[25] = blocks11[26] = blocks11[27] = blocks11[28] = blocks11[29] = blocks11[30] = blocks11[31] = blocks11[32] = 0;
            }
            if (typeof msg !== "string") {
                for(i35 = this.#start; index7 < length5 && i35 < 128; ++index7){
                    blocks11[i35 >> 2] |= msg[index7] << SHIFT1[(i35++) & 3];
                }
            } else {
                for(i35 = this.#start; index7 < length5 && i35 < 128; ++index7){
                    let code15 = msg.charCodeAt(index7);
                    if (code15 < 128) {
                        blocks11[i35 >> 2] |= code15 << SHIFT1[(i35++) & 3];
                    } else if (code15 < 2048) {
                        blocks11[i35 >> 2] |= (192 | code15 >> 6) << SHIFT1[(i35++) & 3];
                        blocks11[i35 >> 2] |= (128 | code15 & 63) << SHIFT1[(i35++) & 3];
                    } else if (code15 < 55296 || code15 >= 57344) {
                        blocks11[i35 >> 2] |= (224 | code15 >> 12) << SHIFT1[(i35++) & 3];
                        blocks11[i35 >> 2] |= (128 | code15 >> 6 & 63) << SHIFT1[(i35++) & 3];
                        blocks11[i35 >> 2] |= (128 | code15 & 63) << SHIFT1[(i35++) & 3];
                    } else {
                        code15 = 65536 + ((code15 & 1023) << 10 | msg.charCodeAt(++index7) & 1023);
                        blocks11[i35 >> 2] |= (240 | code15 >> 18) << SHIFT1[(i35++) & 3];
                        blocks11[i35 >> 2] |= (128 | code15 >> 12 & 63) << SHIFT1[(i35++) & 3];
                        blocks11[i35 >> 2] |= (128 | code15 >> 6 & 63) << SHIFT1[(i35++) & 3];
                        blocks11[i35 >> 2] |= (128 | code15 & 63) << SHIFT1[(i35++) & 3];
                    }
                }
            }
            this.#lastByteIndex = i35;
            this.#bytes += i35 - this.#start;
            if (i35 >= 128) {
                this.#block = blocks11[32];
                this.#start = i35 - 128;
                this.hash();
                this.#hashed = true;
            } else {
                this.#start = i35;
            }
        }
        if (this.#bytes > 4294967295) {
            this.#hBytes += this.#bytes / 4294967296 << 0;
            this.#bytes = this.#bytes % 4294967296;
        }
        return this;
    }
    finalize() {
        if (this.#finalized) {
            return;
        }
        this.#finalized = true;
        const blocks2 = this.#blocks;
        const i36 = this.#lastByteIndex;
        blocks2[32] = this.#block;
        blocks2[i36 >> 2] |= EXTRA1[i36 & 3];
        this.#block = blocks2[32];
        if (i36 >= 112) {
            if (!this.#hashed) {
                this.hash();
            }
            blocks2[0] = this.#block;
            blocks2[1] = blocks2[2] = blocks2[3] = blocks2[4] = blocks2[5] = blocks2[6] = blocks2[7] = blocks2[8] = blocks2[9] = blocks2[10] = blocks2[11] = blocks2[12] = blocks2[13] = blocks2[14] = blocks2[15] = blocks2[16] = blocks2[17] = blocks2[18] = blocks2[19] = blocks2[20] = blocks2[21] = blocks2[22] = blocks2[23] = blocks2[24] = blocks2[25] = blocks2[26] = blocks2[27] = blocks2[28] = blocks2[29] = blocks2[30] = blocks2[31] = blocks2[32] = 0;
        }
        blocks2[30] = this.#hBytes << 3 | this.#bytes >>> 29;
        blocks2[31] = this.#bytes << 3;
        this.hash();
    }
    hash() {
        const h0h = this.#h0h, h0l = this.#h0l, h1h = this.#h1h, h1l = this.#h1l, h2h = this.#h2h, h2l = this.#h2l, h3h = this.#h3h, h3l = this.#h3l, h4h = this.#h4h, h4l = this.#h4l, h5h = this.#h5h, h5l = this.#h5l, h6h = this.#h6h, h6l = this.#h6l, h7h = this.#h7h, h7l = this.#h7l;
        let s0h, s0l, s1h, s1l, c1, c2, c3, c4, abh, abl, dah, dal, cdh, cdl, bch, bcl, majh, majl, t1h, t1l, t2h, t2l, chh, chl;
        const blocks3 = this.#blocks;
        for(let j = 32; j < 160; j += 2){
            t1h = blocks3[j - 30];
            t1l = blocks3[j - 29];
            s0h = (t1h >>> 1 | t1l << 31) ^ (t1h >>> 8 | t1l << 24) ^ t1h >>> 7;
            s0l = (t1l >>> 1 | t1h << 31) ^ (t1l >>> 8 | t1h << 24) ^ (t1l >>> 7 | t1h << 25);
            t1h = blocks3[j - 4];
            t1l = blocks3[j - 3];
            s1h = (t1h >>> 19 | t1l << 13) ^ (t1l >>> 29 | t1h << 3) ^ t1h >>> 6;
            s1l = (t1l >>> 19 | t1h << 13) ^ (t1h >>> 29 | t1l << 3) ^ (t1l >>> 6 | t1h << 26);
            t1h = blocks3[j - 32];
            t1l = blocks3[j - 31];
            t2h = blocks3[j - 14];
            t2l = blocks3[j - 13];
            c1 = (t2l & 65535) + (t1l & 65535) + (s0l & 65535) + (s1l & 65535);
            c2 = (t2l >>> 16) + (t1l >>> 16) + (s0l >>> 16) + (s1l >>> 16) + (c1 >>> 16);
            c3 = (t2h & 65535) + (t1h & 65535) + (s0h & 65535) + (s1h & 65535) + (c2 >>> 16);
            c4 = (t2h >>> 16) + (t1h >>> 16) + (s0h >>> 16) + (s1h >>> 16) + (c3 >>> 16);
            blocks3[j] = c4 << 16 | c3 & 65535;
            blocks3[j + 1] = c2 << 16 | c1 & 65535;
        }
        let ah = h0h, al = h0l, bh = h1h, bl = h1l, ch = h2h, cl = h2l, dh = h3h, dl = h3l, eh = h4h, el = h4l, fh = h5h, fl = h5l, gh = h6h, gl = h6l, hh = h7h, hl = h7l;
        bch = bh & ch;
        bcl = bl & cl;
        for(let j1 = 0; j1 < 160; j1 += 8){
            s0h = (ah >>> 28 | al << 4) ^ (al >>> 2 | ah << 30) ^ (al >>> 7 | ah << 25);
            s0l = (al >>> 28 | ah << 4) ^ (ah >>> 2 | al << 30) ^ (ah >>> 7 | al << 25);
            s1h = (eh >>> 14 | el << 18) ^ (eh >>> 18 | el << 14) ^ (el >>> 9 | eh << 23);
            s1l = (el >>> 14 | eh << 18) ^ (el >>> 18 | eh << 14) ^ (eh >>> 9 | el << 23);
            abh = ah & bh;
            abl = al & bl;
            majh = abh ^ ah & ch ^ bch;
            majl = abl ^ al & cl ^ bcl;
            chh = eh & fh ^ ~eh & gh;
            chl = el & fl ^ ~el & gl;
            t1h = blocks3[j1];
            t1l = blocks3[j1 + 1];
            t2h = K1[j1];
            t2l = K1[j1 + 1];
            c1 = (t2l & 65535) + (t1l & 65535) + (chl & 65535) + (s1l & 65535) + (hl & 65535);
            c2 = (t2l >>> 16) + (t1l >>> 16) + (chl >>> 16) + (s1l >>> 16) + (hl >>> 16) + (c1 >>> 16);
            c3 = (t2h & 65535) + (t1h & 65535) + (chh & 65535) + (s1h & 65535) + (hh & 65535) + (c2 >>> 16);
            c4 = (t2h >>> 16) + (t1h >>> 16) + (chh >>> 16) + (s1h >>> 16) + (hh >>> 16) + (c3 >>> 16);
            t1h = c4 << 16 | c3 & 65535;
            t1l = c2 << 16 | c1 & 65535;
            c1 = (majl & 65535) + (s0l & 65535);
            c2 = (majl >>> 16) + (s0l >>> 16) + (c1 >>> 16);
            c3 = (majh & 65535) + (s0h & 65535) + (c2 >>> 16);
            c4 = (majh >>> 16) + (s0h >>> 16) + (c3 >>> 16);
            t2h = c4 << 16 | c3 & 65535;
            t2l = c2 << 16 | c1 & 65535;
            c1 = (dl & 65535) + (t1l & 65535);
            c2 = (dl >>> 16) + (t1l >>> 16) + (c1 >>> 16);
            c3 = (dh & 65535) + (t1h & 65535) + (c2 >>> 16);
            c4 = (dh >>> 16) + (t1h >>> 16) + (c3 >>> 16);
            hh = c4 << 16 | c3 & 65535;
            hl = c2 << 16 | c1 & 65535;
            c1 = (t2l & 65535) + (t1l & 65535);
            c2 = (t2l >>> 16) + (t1l >>> 16) + (c1 >>> 16);
            c3 = (t2h & 65535) + (t1h & 65535) + (c2 >>> 16);
            c4 = (t2h >>> 16) + (t1h >>> 16) + (c3 >>> 16);
            dh = c4 << 16 | c3 & 65535;
            dl = c2 << 16 | c1 & 65535;
            s0h = (dh >>> 28 | dl << 4) ^ (dl >>> 2 | dh << 30) ^ (dl >>> 7 | dh << 25);
            s0l = (dl >>> 28 | dh << 4) ^ (dh >>> 2 | dl << 30) ^ (dh >>> 7 | dl << 25);
            s1h = (hh >>> 14 | hl << 18) ^ (hh >>> 18 | hl << 14) ^ (hl >>> 9 | hh << 23);
            s1l = (hl >>> 14 | hh << 18) ^ (hl >>> 18 | hh << 14) ^ (hh >>> 9 | hl << 23);
            dah = dh & ah;
            dal = dl & al;
            majh = dah ^ dh & bh ^ abh;
            majl = dal ^ dl & bl ^ abl;
            chh = hh & eh ^ ~hh & fh;
            chl = hl & el ^ ~hl & fl;
            t1h = blocks3[j1 + 2];
            t1l = blocks3[j1 + 3];
            t2h = K1[j1 + 2];
            t2l = K1[j1 + 3];
            c1 = (t2l & 65535) + (t1l & 65535) + (chl & 65535) + (s1l & 65535) + (gl & 65535);
            c2 = (t2l >>> 16) + (t1l >>> 16) + (chl >>> 16) + (s1l >>> 16) + (gl >>> 16) + (c1 >>> 16);
            c3 = (t2h & 65535) + (t1h & 65535) + (chh & 65535) + (s1h & 65535) + (gh & 65535) + (c2 >>> 16);
            c4 = (t2h >>> 16) + (t1h >>> 16) + (chh >>> 16) + (s1h >>> 16) + (gh >>> 16) + (c3 >>> 16);
            t1h = c4 << 16 | c3 & 65535;
            t1l = c2 << 16 | c1 & 65535;
            c1 = (majl & 65535) + (s0l & 65535);
            c2 = (majl >>> 16) + (s0l >>> 16) + (c1 >>> 16);
            c3 = (majh & 65535) + (s0h & 65535) + (c2 >>> 16);
            c4 = (majh >>> 16) + (s0h >>> 16) + (c3 >>> 16);
            t2h = c4 << 16 | c3 & 65535;
            t2l = c2 << 16 | c1 & 65535;
            c1 = (cl & 65535) + (t1l & 65535);
            c2 = (cl >>> 16) + (t1l >>> 16) + (c1 >>> 16);
            c3 = (ch & 65535) + (t1h & 65535) + (c2 >>> 16);
            c4 = (ch >>> 16) + (t1h >>> 16) + (c3 >>> 16);
            gh = c4 << 16 | c3 & 65535;
            gl = c2 << 16 | c1 & 65535;
            c1 = (t2l & 65535) + (t1l & 65535);
            c2 = (t2l >>> 16) + (t1l >>> 16) + (c1 >>> 16);
            c3 = (t2h & 65535) + (t1h & 65535) + (c2 >>> 16);
            c4 = (t2h >>> 16) + (t1h >>> 16) + (c3 >>> 16);
            ch = c4 << 16 | c3 & 65535;
            cl = c2 << 16 | c1 & 65535;
            s0h = (ch >>> 28 | cl << 4) ^ (cl >>> 2 | ch << 30) ^ (cl >>> 7 | ch << 25);
            s0l = (cl >>> 28 | ch << 4) ^ (ch >>> 2 | cl << 30) ^ (ch >>> 7 | cl << 25);
            s1h = (gh >>> 14 | gl << 18) ^ (gh >>> 18 | gl << 14) ^ (gl >>> 9 | gh << 23);
            s1l = (gl >>> 14 | gh << 18) ^ (gl >>> 18 | gh << 14) ^ (gh >>> 9 | gl << 23);
            cdh = ch & dh;
            cdl = cl & dl;
            majh = cdh ^ ch & ah ^ dah;
            majl = cdl ^ cl & al ^ dal;
            chh = gh & hh ^ ~gh & eh;
            chl = gl & hl ^ ~gl & el;
            t1h = blocks3[j1 + 4];
            t1l = blocks3[j1 + 5];
            t2h = K1[j1 + 4];
            t2l = K1[j1 + 5];
            c1 = (t2l & 65535) + (t1l & 65535) + (chl & 65535) + (s1l & 65535) + (fl & 65535);
            c2 = (t2l >>> 16) + (t1l >>> 16) + (chl >>> 16) + (s1l >>> 16) + (fl >>> 16) + (c1 >>> 16);
            c3 = (t2h & 65535) + (t1h & 65535) + (chh & 65535) + (s1h & 65535) + (fh & 65535) + (c2 >>> 16);
            c4 = (t2h >>> 16) + (t1h >>> 16) + (chh >>> 16) + (s1h >>> 16) + (fh >>> 16) + (c3 >>> 16);
            t1h = c4 << 16 | c3 & 65535;
            t1l = c2 << 16 | c1 & 65535;
            c1 = (majl & 65535) + (s0l & 65535);
            c2 = (majl >>> 16) + (s0l >>> 16) + (c1 >>> 16);
            c3 = (majh & 65535) + (s0h & 65535) + (c2 >>> 16);
            c4 = (majh >>> 16) + (s0h >>> 16) + (c3 >>> 16);
            t2h = c4 << 16 | c3 & 65535;
            t2l = c2 << 16 | c1 & 65535;
            c1 = (bl & 65535) + (t1l & 65535);
            c2 = (bl >>> 16) + (t1l >>> 16) + (c1 >>> 16);
            c3 = (bh & 65535) + (t1h & 65535) + (c2 >>> 16);
            c4 = (bh >>> 16) + (t1h >>> 16) + (c3 >>> 16);
            fh = c4 << 16 | c3 & 65535;
            fl = c2 << 16 | c1 & 65535;
            c1 = (t2l & 65535) + (t1l & 65535);
            c2 = (t2l >>> 16) + (t1l >>> 16) + (c1 >>> 16);
            c3 = (t2h & 65535) + (t1h & 65535) + (c2 >>> 16);
            c4 = (t2h >>> 16) + (t1h >>> 16) + (c3 >>> 16);
            bh = c4 << 16 | c3 & 65535;
            bl = c2 << 16 | c1 & 65535;
            s0h = (bh >>> 28 | bl << 4) ^ (bl >>> 2 | bh << 30) ^ (bl >>> 7 | bh << 25);
            s0l = (bl >>> 28 | bh << 4) ^ (bh >>> 2 | bl << 30) ^ (bh >>> 7 | bl << 25);
            s1h = (fh >>> 14 | fl << 18) ^ (fh >>> 18 | fl << 14) ^ (fl >>> 9 | fh << 23);
            s1l = (fl >>> 14 | fh << 18) ^ (fl >>> 18 | fh << 14) ^ (fh >>> 9 | fl << 23);
            bch = bh & ch;
            bcl = bl & cl;
            majh = bch ^ bh & dh ^ cdh;
            majl = bcl ^ bl & dl ^ cdl;
            chh = fh & gh ^ ~fh & hh;
            chl = fl & gl ^ ~fl & hl;
            t1h = blocks3[j1 + 6];
            t1l = blocks3[j1 + 7];
            t2h = K1[j1 + 6];
            t2l = K1[j1 + 7];
            c1 = (t2l & 65535) + (t1l & 65535) + (chl & 65535) + (s1l & 65535) + (el & 65535);
            c2 = (t2l >>> 16) + (t1l >>> 16) + (chl >>> 16) + (s1l >>> 16) + (el >>> 16) + (c1 >>> 16);
            c3 = (t2h & 65535) + (t1h & 65535) + (chh & 65535) + (s1h & 65535) + (eh & 65535) + (c2 >>> 16);
            c4 = (t2h >>> 16) + (t1h >>> 16) + (chh >>> 16) + (s1h >>> 16) + (eh >>> 16) + (c3 >>> 16);
            t1h = c4 << 16 | c3 & 65535;
            t1l = c2 << 16 | c1 & 65535;
            c1 = (majl & 65535) + (s0l & 65535);
            c2 = (majl >>> 16) + (s0l >>> 16) + (c1 >>> 16);
            c3 = (majh & 65535) + (s0h & 65535) + (c2 >>> 16);
            c4 = (majh >>> 16) + (s0h >>> 16) + (c3 >>> 16);
            t2h = c4 << 16 | c3 & 65535;
            t2l = c2 << 16 | c1 & 65535;
            c1 = (al & 65535) + (t1l & 65535);
            c2 = (al >>> 16) + (t1l >>> 16) + (c1 >>> 16);
            c3 = (ah & 65535) + (t1h & 65535) + (c2 >>> 16);
            c4 = (ah >>> 16) + (t1h >>> 16) + (c3 >>> 16);
            eh = c4 << 16 | c3 & 65535;
            el = c2 << 16 | c1 & 65535;
            c1 = (t2l & 65535) + (t1l & 65535);
            c2 = (t2l >>> 16) + (t1l >>> 16) + (c1 >>> 16);
            c3 = (t2h & 65535) + (t1h & 65535) + (c2 >>> 16);
            c4 = (t2h >>> 16) + (t1h >>> 16) + (c3 >>> 16);
            ah = c4 << 16 | c3 & 65535;
            al = c2 << 16 | c1 & 65535;
        }
        c1 = (h0l & 65535) + (al & 65535);
        c2 = (h0l >>> 16) + (al >>> 16) + (c1 >>> 16);
        c3 = (h0h & 65535) + (ah & 65535) + (c2 >>> 16);
        c4 = (h0h >>> 16) + (ah >>> 16) + (c3 >>> 16);
        this.#h0h = c4 << 16 | c3 & 65535;
        this.#h0l = c2 << 16 | c1 & 65535;
        c1 = (h1l & 65535) + (bl & 65535);
        c2 = (h1l >>> 16) + (bl >>> 16) + (c1 >>> 16);
        c3 = (h1h & 65535) + (bh & 65535) + (c2 >>> 16);
        c4 = (h1h >>> 16) + (bh >>> 16) + (c3 >>> 16);
        this.#h1h = c4 << 16 | c3 & 65535;
        this.#h1l = c2 << 16 | c1 & 65535;
        c1 = (h2l & 65535) + (cl & 65535);
        c2 = (h2l >>> 16) + (cl >>> 16) + (c1 >>> 16);
        c3 = (h2h & 65535) + (ch & 65535) + (c2 >>> 16);
        c4 = (h2h >>> 16) + (ch >>> 16) + (c3 >>> 16);
        this.#h2h = c4 << 16 | c3 & 65535;
        this.#h2l = c2 << 16 | c1 & 65535;
        c1 = (h3l & 65535) + (dl & 65535);
        c2 = (h3l >>> 16) + (dl >>> 16) + (c1 >>> 16);
        c3 = (h3h & 65535) + (dh & 65535) + (c2 >>> 16);
        c4 = (h3h >>> 16) + (dh >>> 16) + (c3 >>> 16);
        this.#h3h = c4 << 16 | c3 & 65535;
        this.#h3l = c2 << 16 | c1 & 65535;
        c1 = (h4l & 65535) + (el & 65535);
        c2 = (h4l >>> 16) + (el >>> 16) + (c1 >>> 16);
        c3 = (h4h & 65535) + (eh & 65535) + (c2 >>> 16);
        c4 = (h4h >>> 16) + (eh >>> 16) + (c3 >>> 16);
        this.#h4h = c4 << 16 | c3 & 65535;
        this.#h4l = c2 << 16 | c1 & 65535;
        c1 = (h5l & 65535) + (fl & 65535);
        c2 = (h5l >>> 16) + (fl >>> 16) + (c1 >>> 16);
        c3 = (h5h & 65535) + (fh & 65535) + (c2 >>> 16);
        c4 = (h5h >>> 16) + (fh >>> 16) + (c3 >>> 16);
        this.#h5h = c4 << 16 | c3 & 65535;
        this.#h5l = c2 << 16 | c1 & 65535;
        c1 = (h6l & 65535) + (gl & 65535);
        c2 = (h6l >>> 16) + (gl >>> 16) + (c1 >>> 16);
        c3 = (h6h & 65535) + (gh & 65535) + (c2 >>> 16);
        c4 = (h6h >>> 16) + (gh >>> 16) + (c3 >>> 16);
        this.#h6h = c4 << 16 | c3 & 65535;
        this.#h6l = c2 << 16 | c1 & 65535;
        c1 = (h7l & 65535) + (hl & 65535);
        c2 = (h7l >>> 16) + (hl >>> 16) + (c1 >>> 16);
        c3 = (h7h & 65535) + (hh & 65535) + (c2 >>> 16);
        c4 = (h7h >>> 16) + (hh >>> 16) + (c3 >>> 16);
        this.#h7h = c4 << 16 | c3 & 65535;
        this.#h7l = c2 << 16 | c1 & 65535;
    }
    hex() {
        this.finalize();
        const h0h = this.#h0h, h0l = this.#h0l, h1h = this.#h1h, h1l = this.#h1l, h2h = this.#h2h, h2l = this.#h2l, h3h = this.#h3h, h3l = this.#h3l, h4h = this.#h4h, h4l = this.#h4l, h5h = this.#h5h, h5l = this.#h5l, h6h = this.#h6h, h6l = this.#h6l, h7h = this.#h7h, h7l = this.#h7l, bits = this.#bits;
        let hex = HEX_CHARS1[h0h >> 28 & 15] + HEX_CHARS1[h0h >> 24 & 15] + HEX_CHARS1[h0h >> 20 & 15] + HEX_CHARS1[h0h >> 16 & 15] + HEX_CHARS1[h0h >> 12 & 15] + HEX_CHARS1[h0h >> 8 & 15] + HEX_CHARS1[h0h >> 4 & 15] + HEX_CHARS1[h0h & 15] + HEX_CHARS1[h0l >> 28 & 15] + HEX_CHARS1[h0l >> 24 & 15] + HEX_CHARS1[h0l >> 20 & 15] + HEX_CHARS1[h0l >> 16 & 15] + HEX_CHARS1[h0l >> 12 & 15] + HEX_CHARS1[h0l >> 8 & 15] + HEX_CHARS1[h0l >> 4 & 15] + HEX_CHARS1[h0l & 15] + HEX_CHARS1[h1h >> 28 & 15] + HEX_CHARS1[h1h >> 24 & 15] + HEX_CHARS1[h1h >> 20 & 15] + HEX_CHARS1[h1h >> 16 & 15] + HEX_CHARS1[h1h >> 12 & 15] + HEX_CHARS1[h1h >> 8 & 15] + HEX_CHARS1[h1h >> 4 & 15] + HEX_CHARS1[h1h & 15] + HEX_CHARS1[h1l >> 28 & 15] + HEX_CHARS1[h1l >> 24 & 15] + HEX_CHARS1[h1l >> 20 & 15] + HEX_CHARS1[h1l >> 16 & 15] + HEX_CHARS1[h1l >> 12 & 15] + HEX_CHARS1[h1l >> 8 & 15] + HEX_CHARS1[h1l >> 4 & 15] + HEX_CHARS1[h1l & 15] + HEX_CHARS1[h2h >> 28 & 15] + HEX_CHARS1[h2h >> 24 & 15] + HEX_CHARS1[h2h >> 20 & 15] + HEX_CHARS1[h2h >> 16 & 15] + HEX_CHARS1[h2h >> 12 & 15] + HEX_CHARS1[h2h >> 8 & 15] + HEX_CHARS1[h2h >> 4 & 15] + HEX_CHARS1[h2h & 15] + HEX_CHARS1[h2l >> 28 & 15] + HEX_CHARS1[h2l >> 24 & 15] + HEX_CHARS1[h2l >> 20 & 15] + HEX_CHARS1[h2l >> 16 & 15] + HEX_CHARS1[h2l >> 12 & 15] + HEX_CHARS1[h2l >> 8 & 15] + HEX_CHARS1[h2l >> 4 & 15] + HEX_CHARS1[h2l & 15] + HEX_CHARS1[h3h >> 28 & 15] + HEX_CHARS1[h3h >> 24 & 15] + HEX_CHARS1[h3h >> 20 & 15] + HEX_CHARS1[h3h >> 16 & 15] + HEX_CHARS1[h3h >> 12 & 15] + HEX_CHARS1[h3h >> 8 & 15] + HEX_CHARS1[h3h >> 4 & 15] + HEX_CHARS1[h3h & 15];
        if (bits >= 256) {
            hex += HEX_CHARS1[h3l >> 28 & 15] + HEX_CHARS1[h3l >> 24 & 15] + HEX_CHARS1[h3l >> 20 & 15] + HEX_CHARS1[h3l >> 16 & 15] + HEX_CHARS1[h3l >> 12 & 15] + HEX_CHARS1[h3l >> 8 & 15] + HEX_CHARS1[h3l >> 4 & 15] + HEX_CHARS1[h3l & 15];
        }
        if (bits >= 384) {
            hex += HEX_CHARS1[h4h >> 28 & 15] + HEX_CHARS1[h4h >> 24 & 15] + HEX_CHARS1[h4h >> 20 & 15] + HEX_CHARS1[h4h >> 16 & 15] + HEX_CHARS1[h4h >> 12 & 15] + HEX_CHARS1[h4h >> 8 & 15] + HEX_CHARS1[h4h >> 4 & 15] + HEX_CHARS1[h4h & 15] + HEX_CHARS1[h4l >> 28 & 15] + HEX_CHARS1[h4l >> 24 & 15] + HEX_CHARS1[h4l >> 20 & 15] + HEX_CHARS1[h4l >> 16 & 15] + HEX_CHARS1[h4l >> 12 & 15] + HEX_CHARS1[h4l >> 8 & 15] + HEX_CHARS1[h4l >> 4 & 15] + HEX_CHARS1[h4l & 15] + HEX_CHARS1[h5h >> 28 & 15] + HEX_CHARS1[h5h >> 24 & 15] + HEX_CHARS1[h5h >> 20 & 15] + HEX_CHARS1[h5h >> 16 & 15] + HEX_CHARS1[h5h >> 12 & 15] + HEX_CHARS1[h5h >> 8 & 15] + HEX_CHARS1[h5h >> 4 & 15] + HEX_CHARS1[h5h & 15] + HEX_CHARS1[h5l >> 28 & 15] + HEX_CHARS1[h5l >> 24 & 15] + HEX_CHARS1[h5l >> 20 & 15] + HEX_CHARS1[h5l >> 16 & 15] + HEX_CHARS1[h5l >> 12 & 15] + HEX_CHARS1[h5l >> 8 & 15] + HEX_CHARS1[h5l >> 4 & 15] + HEX_CHARS1[h5l & 15];
        }
        if (bits === 512) {
            hex += HEX_CHARS1[h6h >> 28 & 15] + HEX_CHARS1[h6h >> 24 & 15] + HEX_CHARS1[h6h >> 20 & 15] + HEX_CHARS1[h6h >> 16 & 15] + HEX_CHARS1[h6h >> 12 & 15] + HEX_CHARS1[h6h >> 8 & 15] + HEX_CHARS1[h6h >> 4 & 15] + HEX_CHARS1[h6h & 15] + HEX_CHARS1[h6l >> 28 & 15] + HEX_CHARS1[h6l >> 24 & 15] + HEX_CHARS1[h6l >> 20 & 15] + HEX_CHARS1[h6l >> 16 & 15] + HEX_CHARS1[h6l >> 12 & 15] + HEX_CHARS1[h6l >> 8 & 15] + HEX_CHARS1[h6l >> 4 & 15] + HEX_CHARS1[h6l & 15] + HEX_CHARS1[h7h >> 28 & 15] + HEX_CHARS1[h7h >> 24 & 15] + HEX_CHARS1[h7h >> 20 & 15] + HEX_CHARS1[h7h >> 16 & 15] + HEX_CHARS1[h7h >> 12 & 15] + HEX_CHARS1[h7h >> 8 & 15] + HEX_CHARS1[h7h >> 4 & 15] + HEX_CHARS1[h7h & 15] + HEX_CHARS1[h7l >> 28 & 15] + HEX_CHARS1[h7l >> 24 & 15] + HEX_CHARS1[h7l >> 20 & 15] + HEX_CHARS1[h7l >> 16 & 15] + HEX_CHARS1[h7l >> 12 & 15] + HEX_CHARS1[h7l >> 8 & 15] + HEX_CHARS1[h7l >> 4 & 15] + HEX_CHARS1[h7l & 15];
        }
        return hex;
    }
    toString() {
        return this.hex();
    }
    digest() {
        this.finalize();
        const h0h = this.#h0h, h0l = this.#h0l, h1h = this.#h1h, h1l = this.#h1l, h2h = this.#h2h, h2l = this.#h2l, h3h = this.#h3h, h3l = this.#h3l, h4h = this.#h4h, h4l = this.#h4l, h5h = this.#h5h, h5l = this.#h5l, h6h = this.#h6h, h6l = this.#h6l, h7h = this.#h7h, h7l = this.#h7l, bits = this.#bits;
        const arr = [
            h0h >> 24 & 255,
            h0h >> 16 & 255,
            h0h >> 8 & 255,
            h0h & 255,
            h0l >> 24 & 255,
            h0l >> 16 & 255,
            h0l >> 8 & 255,
            h0l & 255,
            h1h >> 24 & 255,
            h1h >> 16 & 255,
            h1h >> 8 & 255,
            h1h & 255,
            h1l >> 24 & 255,
            h1l >> 16 & 255,
            h1l >> 8 & 255,
            h1l & 255,
            h2h >> 24 & 255,
            h2h >> 16 & 255,
            h2h >> 8 & 255,
            h2h & 255,
            h2l >> 24 & 255,
            h2l >> 16 & 255,
            h2l >> 8 & 255,
            h2l & 255,
            h3h >> 24 & 255,
            h3h >> 16 & 255,
            h3h >> 8 & 255,
            h3h & 255
        ];
        if (bits >= 256) {
            arr.push(h3l >> 24 & 255, h3l >> 16 & 255, h3l >> 8 & 255, h3l & 255);
        }
        if (bits >= 384) {
            arr.push(h4h >> 24 & 255, h4h >> 16 & 255, h4h >> 8 & 255, h4h & 255, h4l >> 24 & 255, h4l >> 16 & 255, h4l >> 8 & 255, h4l & 255, h5h >> 24 & 255, h5h >> 16 & 255, h5h >> 8 & 255, h5h & 255, h5l >> 24 & 255, h5l >> 16 & 255, h5l >> 8 & 255, h5l & 255);
        }
        if (bits === 512) {
            arr.push(h6h >> 24 & 255, h6h >> 16 & 255, h6h >> 8 & 255, h6h & 255, h6l >> 24 & 255, h6l >> 16 & 255, h6l >> 8 & 255, h6l & 255, h7h >> 24 & 255, h7h >> 16 & 255, h7h >> 8 & 255, h7h & 255, h7l >> 24 & 255, h7l >> 16 & 255, h7l >> 8 & 255, h7l & 255);
        }
        return arr;
    }
    array() {
        return this.digest();
    }
    arrayBuffer() {
        this.finalize();
        const bits = this.#bits;
        const buffer = new ArrayBuffer(bits / 8);
        const dataView = new DataView(buffer);
        dataView.setUint32(0, this.#h0h);
        dataView.setUint32(4, this.#h0l);
        dataView.setUint32(8, this.#h1h);
        dataView.setUint32(12, this.#h1l);
        dataView.setUint32(16, this.#h2h);
        dataView.setUint32(20, this.#h2l);
        dataView.setUint32(24, this.#h3h);
        if (bits >= 256) {
            dataView.setUint32(28, this.#h3l);
        }
        if (bits >= 384) {
            dataView.setUint32(32, this.#h4h);
            dataView.setUint32(36, this.#h4l);
            dataView.setUint32(40, this.#h5h);
            dataView.setUint32(44, this.#h5l);
        }
        if (bits === 512) {
            dataView.setUint32(48, this.#h6h);
            dataView.setUint32(52, this.#h6l);
            dataView.setUint32(56, this.#h7h);
            dataView.setUint32(60, this.#h7l);
        }
        return buffer;
    }
}
class HmacSha512 extends Sha512 {
    #inner;
    #bits;
    #oKeyPad;
    #sharedMemory;
    constructor(secretKey, bits = 512, sharedMemory = false){
        super(bits, sharedMemory);
        let key;
        if (secretKey instanceof ArrayBuffer) {
            key = new Uint8Array(secretKey);
        } else if (typeof secretKey === "string") {
            const bytes = [];
            const length6 = secretKey.length;
            let index = 0;
            let code16;
            for(let i37 = 0; i37 < length6; ++i37){
                code16 = secretKey.charCodeAt(i37);
                if (code16 < 128) {
                    bytes[index++] = code16;
                } else if (code16 < 2048) {
                    bytes[index++] = 192 | code16 >> 6;
                    bytes[index++] = 128 | code16 & 63;
                } else if (code16 < 55296 || code16 >= 57344) {
                    bytes[index++] = 224 | code16 >> 12;
                    bytes[index++] = 128 | code16 >> 6 & 63;
                    bytes[index++] = 128 | code16 & 63;
                } else {
                    code16 = 65536 + ((code16 & 1023) << 10 | secretKey.charCodeAt(++i37) & 1023);
                    bytes[index++] = 240 | code16 >> 18;
                    bytes[index++] = 128 | code16 >> 12 & 63;
                    bytes[index++] = 128 | code16 >> 6 & 63;
                    bytes[index++] = 128 | code16 & 63;
                }
            }
            key = bytes;
        } else {
            key = secretKey;
        }
        if (key.length > 128) {
            key = new Sha512(bits, true).update(key).array();
        }
        const oKeyPad = [];
        const iKeyPad = [];
        for(let i38 = 0; i38 < 128; ++i38){
            const b = key[i38] || 0;
            oKeyPad[i38] = 92 ^ b;
            iKeyPad[i38] = 54 ^ b;
        }
        this.update(iKeyPad);
        this.#inner = true;
        this.#bits = bits;
        this.#oKeyPad = oKeyPad;
        this.#sharedMemory = sharedMemory;
    }
    finalize() {
        super.finalize();
        if (this.#inner) {
            this.#inner = false;
            const innerHash = this.array();
            super.init(this.#bits, this.#sharedMemory);
            this.update(this.#oKeyPad);
            this.update(innerHash);
            super.finalize();
        }
    }
}
function big_base64(m) {
    if (m === undefined) return undefined;
    const bytes = [];
    while(m > 0n){
        bytes.push(Number(m & 255n));
        m = m >> 8n;
    }
    bytes.reverse();
    let a = btoa(String.fromCharCode.apply(null, bytes)).replace(/=/g, "");
    a = a.replace(/\+/g, "-");
    a = a.replace(/\//g, "_");
    return a;
}
function getHashFunctionName(hash) {
    if (hash === "sha1") return "SHA-1";
    if (hash === "sha256") return "SHA-256";
    return "";
}
async function createWebCryptoKey(key, usage, options) {
    let jwk = {
        kty: "RSA",
        n: big_base64(key.n),
        ext: true
    };
    if (usage === "encrypt") {
        jwk = {
            ...jwk,
            e: big_base64(key.e)
        };
    } else if (usage === "decrypt") {
        jwk = {
            ...jwk,
            d: big_base64(key.d),
            e: big_base64(key.e),
            p: big_base64(key.p),
            q: big_base64(key.q),
            dp: big_base64(key.dp),
            dq: big_base64(key.dq),
            qi: big_base64(key.qi)
        };
    }
    return await crypto.subtle.importKey("jwk", jwk, {
        name: "RSA-OAEP",
        hash: {
            name: getHashFunctionName(options.hash)
        }
    }, false, [
        usage
    ]);
}
class WebCryptoRSA {
    key;
    options;
    encryptedKey = null;
    decryptedKey = null;
    constructor(key, options){
        this.key = key;
        this.options = options;
    }
    static isSupported(options) {
        if (!crypto.subtle) return false;
        if (options.padding !== "oaep") return false;
        return true;
    }
    static async encrypt(key, m, options) {
        return await crypto.subtle.encrypt({
            name: "RSA-OAEP"
        }, await createWebCryptoKey(key, "encrypt", options), m);
    }
    static async decrypt(key, m, options) {
        return await crypto.subtle.decrypt({
            name: "RSA-OAEP"
        }, await createWebCryptoKey(key, "decrypt", options), m);
    }
}
function power_mod(n, p, m) {
    if (p === 1n) return n;
    if (p % 2n === 0n) {
        const t = power_mod(n, p >> 1n, m);
        return t * t % m;
    } else {
        const t = power_mod(n, p >> 1n, m);
        return t * t * n % m;
    }
}
function getLengths(b64) {
    const len = b64.length;
    let validLen = b64.indexOf("=");
    if (validLen === -1) {
        validLen = len;
    }
    const placeHoldersLen = validLen === len ? 0 : 4 - validLen % 4;
    return [
        validLen,
        placeHoldersLen
    ];
}
function init1(lookup2, revLookup2, urlsafe = false) {
    function _byteLength(validLen, placeHoldersLen) {
        return Math.floor((validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen);
    }
    function tripletToBase64(num) {
        return lookup2[num >> 18 & 63] + lookup2[num >> 12 & 63] + lookup2[num >> 6 & 63] + lookup2[num & 63];
    }
    function encodeChunk(buf, start, end) {
        const out = new Array((end - start) / 3);
        for(let i39 = start, curTriplet = 0; i39 < end; i39 += 3){
            out[curTriplet++] = tripletToBase64((buf[i39] << 16) + (buf[i39 + 1] << 8) + buf[i39 + 2]);
        }
        return out.join("");
    }
    return {
        byteLength (b64) {
            return _byteLength.apply(null, getLengths(b64));
        },
        toUint8Array (b64) {
            const [validLen, placeHoldersLen] = getLengths(b64);
            const buf = new Uint8Array(_byteLength(validLen, placeHoldersLen));
            const len = placeHoldersLen ? validLen - 4 : validLen;
            let tmp;
            let curByte = 0;
            let i40;
            for(i40 = 0; i40 < len; i40 += 4){
                tmp = revLookup2[b64.charCodeAt(i40)] << 18 | revLookup2[b64.charCodeAt(i40 + 1)] << 12 | revLookup2[b64.charCodeAt(i40 + 2)] << 6 | revLookup2[b64.charCodeAt(i40 + 3)];
                buf[curByte++] = tmp >> 16 & 255;
                buf[curByte++] = tmp >> 8 & 255;
                buf[curByte++] = tmp & 255;
            }
            if (placeHoldersLen === 2) {
                tmp = revLookup2[b64.charCodeAt(i40)] << 2 | revLookup2[b64.charCodeAt(i40 + 1)] >> 4;
                buf[curByte++] = tmp & 255;
            } else if (placeHoldersLen === 1) {
                tmp = revLookup2[b64.charCodeAt(i40)] << 10 | revLookup2[b64.charCodeAt(i40 + 1)] << 4 | revLookup2[b64.charCodeAt(i40 + 2)] >> 2;
                buf[curByte++] = tmp >> 8 & 255;
                buf[curByte++] = tmp & 255;
            }
            return buf;
        },
        fromUint8Array (buf) {
            const maxChunkLength = 16383;
            const len = buf.length;
            const extraBytes = len % 3;
            const len2 = len - extraBytes;
            const parts = new Array(Math.ceil(len2 / 16383) + (extraBytes ? 1 : 0));
            let curChunk = 0;
            let chunkEnd;
            for(let i41 = 0; i41 < len2; i41 += maxChunkLength){
                chunkEnd = i41 + maxChunkLength;
                parts[curChunk++] = encodeChunk(buf, i41, chunkEnd > len2 ? len2 : chunkEnd);
            }
            let tmp;
            if (extraBytes === 1) {
                tmp = buf[len2];
                parts[curChunk] = lookup2[tmp >> 2] + lookup2[tmp << 4 & 63];
                if (!urlsafe) parts[curChunk] += "==";
            } else if (extraBytes === 2) {
                tmp = buf[len2] << 8 | buf[len2 + 1] & 255;
                parts[curChunk] = lookup2[tmp >> 10] + lookup2[tmp >> 4 & 63] + lookup2[tmp << 2 & 63];
                if (!urlsafe) parts[curChunk] += "=";
            }
            return parts.join("");
        }
    };
}
const lookup = [];
const revLookup = [];
const code = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
for(let i = 0, l = code.length; i < l; ++i){
    lookup[i] = code[i];
    revLookup[code.charCodeAt(i)] = i;
}
const { byteLength , toUint8Array , fromUint8Array  } = init1(lookup, revLookup, true);
const decoder = new TextDecoder();
const encoder = new TextEncoder();
function toHexString(buf) {
    return buf.reduce((hex, __byte)=>`${hex}${__byte < 16 ? "0" : ""}${__byte.toString(16)}`
    , "");
}
function fromHexString(hex) {
    const len = hex.length;
    if (len % 2 || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new TypeError("Invalid hex string.");
    }
    hex = hex.toLowerCase();
    const buf = new Uint8Array(Math.floor(len / 2));
    const end = len / 2;
    for(let i42 = 0; i42 < end; ++i42){
        buf[i42] = parseInt(hex.substr(i42 * 2, 2), 16);
    }
    return buf;
}
function decode3(buf, encoding = "utf8") {
    if (/^utf-?8$/i.test(encoding)) {
        return decoder.decode(buf);
    } else if (/^base64$/i.test(encoding)) {
        return fromUint8Array(buf);
    } else if (/^hex(?:adecimal)?$/i.test(encoding)) {
        return toHexString(buf);
    } else {
        throw new TypeError("Unsupported string encoding.");
    }
}
function encode2(str, encoding = "utf8") {
    if (/^utf-?8$/i.test(encoding)) {
        return encoder.encode(str);
    } else if (/^base64$/i.test(encoding)) {
        return toUint8Array(str);
    } else if (/^hex(?:adecimal)?$/i.test(encoding)) {
        return fromHexString(str);
    } else {
        throw new TypeError("Unsupported string encoding.");
    }
}
function rotl(x, n) {
    return x << n | x >>> 32 - n;
}
class SHA1 {
    hashSize = 20;
    _buf = new Uint8Array(64);
    _bufIdx;
    _count;
    _K = new Uint32Array([
        1518500249,
        1859775393,
        2400959708,
        3395469782
    ]);
    _H;
    _finalized;
    constructor(){
        this.init();
    }
    static F(t, b, c, d) {
        if (t <= 19) {
            return b & c | ~b & d;
        } else if (t <= 39) {
            return b ^ c ^ d;
        } else if (t <= 59) {
            return b & c | b & d | c & d;
        } else {
            return b ^ c ^ d;
        }
    }
    init() {
        this._H = new Uint32Array([
            1732584193,
            4023233417,
            2562383102,
            271733878,
            3285377520
        ]);
        this._bufIdx = 0;
        this._count = new Uint32Array(2);
        this._buf.fill(0);
        this._finalized = false;
        return this;
    }
    update(msg, inputEncoding) {
        if (msg === null) {
            throw new TypeError("msg must be a string or Uint8Array.");
        } else if (typeof msg === "string") {
            msg = encode2(msg, inputEncoding);
        }
        for(let i43 = 0; i43 < msg.length; i43++){
            this._buf[this._bufIdx++] = msg[i43];
            if (this._bufIdx === 64) {
                this.transform();
                this._bufIdx = 0;
            }
        }
        const c = this._count;
        if ((c[0] += msg.length << 3) < msg.length << 3) {
            c[1]++;
        }
        c[1] += msg.length >>> 29;
        return this;
    }
    digest(outputEncoding) {
        if (this._finalized) {
            throw new Error("digest has already been called.");
        }
        this._finalized = true;
        const b = this._buf;
        let idx = this._bufIdx;
        b[idx++] = 128;
        while(idx !== 56){
            if (idx === 64) {
                this.transform();
                idx = 0;
            }
            b[idx++] = 0;
        }
        const c = this._count;
        b[56] = c[1] >>> 24 & 255;
        b[57] = c[1] >>> 16 & 255;
        b[58] = c[1] >>> 8 & 255;
        b[59] = c[1] >>> 0 & 255;
        b[60] = c[0] >>> 24 & 255;
        b[61] = c[0] >>> 16 & 255;
        b[62] = c[0] >>> 8 & 255;
        b[63] = c[0] >>> 0 & 255;
        this.transform();
        const hash = new Uint8Array(20);
        for(let i44 = 0; i44 < 5; i44++){
            hash[(i44 << 2) + 0] = this._H[i44] >>> 24 & 255;
            hash[(i44 << 2) + 1] = this._H[i44] >>> 16 & 255;
            hash[(i44 << 2) + 2] = this._H[i44] >>> 8 & 255;
            hash[(i44 << 2) + 3] = this._H[i44] >>> 0 & 255;
        }
        this.init();
        return outputEncoding ? decode3(hash, outputEncoding) : hash;
    }
    transform() {
        const h = this._H;
        let a = h[0];
        let b = h[1];
        let c = h[2];
        let d = h[3];
        let e = h[4];
        const w = new Uint32Array(80);
        for(let i45 = 0; i45 < 16; i45++){
            w[i45] = this._buf[(i45 << 2) + 3] | this._buf[(i45 << 2) + 2] << 8 | this._buf[(i45 << 2) + 1] << 16 | this._buf[i45 << 2] << 24;
        }
        for(let t = 0; t < 80; t++){
            if (t >= 16) {
                w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
            }
            const tmp = rotl(a, 5) + SHA1.F(t, b, c, d) + e + w[t] + this._K[Math.floor(t / 20)] | 0;
            e = d;
            d = c;
            c = rotl(b, 30);
            b = a;
            a = tmp;
        }
        h[0] = h[0] + a | 0;
        h[1] = h[1] + b | 0;
        h[2] = h[2] + c | 0;
        h[3] = h[3] + d | 0;
        h[4] = h[4] + e | 0;
    }
}
function sha1(msg, inputEncoding, outputEncoding) {
    return new SHA1().update(msg, inputEncoding).digest(outputEncoding);
}
class SHA256 {
    hashSize = 32;
    _buf;
    _bufIdx;
    _count;
    _K;
    _H;
    _finalized;
    constructor(){
        this._buf = new Uint8Array(64);
        this._K = new Uint32Array([
            1116352408,
            1899447441,
            3049323471,
            3921009573,
            961987163,
            1508970993,
            2453635748,
            2870763221,
            3624381080,
            310598401,
            607225278,
            1426881987,
            1925078388,
            2162078206,
            2614888103,
            3248222580,
            3835390401,
            4022224774,
            264347078,
            604807628,
            770255983,
            1249150122,
            1555081692,
            1996064986,
            2554220882,
            2821834349,
            2952996808,
            3210313671,
            3336571891,
            3584528711,
            113926993,
            338241895,
            666307205,
            773529912,
            1294757372,
            1396182291,
            1695183700,
            1986661051,
            2177026350,
            2456956037,
            2730485921,
            2820302411,
            3259730800,
            3345764771,
            3516065817,
            3600352804,
            4094571909,
            275423344,
            430227734,
            506948616,
            659060556,
            883997877,
            958139571,
            1322822218,
            1537002063,
            1747873779,
            1955562222,
            2024104815,
            2227730452,
            2361852424,
            2428436474,
            2756734187,
            3204031479,
            3329325298
        ]);
        this.init();
    }
    init() {
        this._H = new Uint32Array([
            1779033703,
            3144134277,
            1013904242,
            2773480762,
            1359893119,
            2600822924,
            528734635,
            1541459225
        ]);
        this._bufIdx = 0;
        this._count = new Uint32Array(2);
        this._buf.fill(0);
        this._finalized = false;
        return this;
    }
    update(msg, inputEncoding) {
        if (msg === null) {
            throw new TypeError("msg must be a string or Uint8Array.");
        } else if (typeof msg === "string") {
            msg = encode2(msg, inputEncoding);
        }
        for(let i46 = 0, len = msg.length; i46 < len; i46++){
            this._buf[this._bufIdx++] = msg[i46];
            if (this._bufIdx === 64) {
                this._transform();
                this._bufIdx = 0;
            }
        }
        const c = this._count;
        if ((c[0] += msg.length << 3) < msg.length << 3) {
            c[1]++;
        }
        c[1] += msg.length >>> 29;
        return this;
    }
    digest(outputEncoding) {
        if (this._finalized) {
            throw new Error("digest has already been called.");
        }
        this._finalized = true;
        const b = this._buf;
        let idx = this._bufIdx;
        b[idx++] = 128;
        while(idx !== 56){
            if (idx === 64) {
                this._transform();
                idx = 0;
            }
            b[idx++] = 0;
        }
        const c = this._count;
        b[56] = c[1] >>> 24 & 255;
        b[57] = c[1] >>> 16 & 255;
        b[58] = c[1] >>> 8 & 255;
        b[59] = c[1] >>> 0 & 255;
        b[60] = c[0] >>> 24 & 255;
        b[61] = c[0] >>> 16 & 255;
        b[62] = c[0] >>> 8 & 255;
        b[63] = c[0] >>> 0 & 255;
        this._transform();
        const hash = new Uint8Array(32);
        for(let i47 = 0; i47 < 8; i47++){
            hash[(i47 << 2) + 0] = this._H[i47] >>> 24 & 255;
            hash[(i47 << 2) + 1] = this._H[i47] >>> 16 & 255;
            hash[(i47 << 2) + 2] = this._H[i47] >>> 8 & 255;
            hash[(i47 << 2) + 3] = this._H[i47] >>> 0 & 255;
        }
        this.init();
        return outputEncoding ? decode3(hash, outputEncoding) : hash;
    }
    _transform() {
        const h = this._H;
        let h0 = h[0];
        let h1 = h[1];
        let h2 = h[2];
        let h3 = h[3];
        let h4 = h[4];
        let h5 = h[5];
        let h6 = h[6];
        let h7 = h[7];
        const w = new Uint32Array(16);
        let i48;
        for(i48 = 0; i48 < 16; i48++){
            w[i48] = this._buf[(i48 << 2) + 3] | this._buf[(i48 << 2) + 2] << 8 | this._buf[(i48 << 2) + 1] << 16 | this._buf[i48 << 2] << 24;
        }
        for(i48 = 0; i48 < 64; i48++){
            let tmp;
            if (i48 < 16) {
                tmp = w[i48];
            } else {
                let a = w[i48 + 1 & 15];
                let b = w[i48 + 14 & 15];
                tmp = w[i48 & 15] = (a >>> 7 ^ a >>> 18 ^ a >>> 3 ^ a << 25 ^ a << 14) + (b >>> 17 ^ b >>> 19 ^ b >>> 10 ^ b << 15 ^ b << 13) + w[i48 & 15] + w[i48 + 9 & 15] | 0;
            }
            tmp = tmp + h7 + (h4 >>> 6 ^ h4 >>> 11 ^ h4 >>> 25 ^ h4 << 26 ^ h4 << 21 ^ h4 << 7) + (h6 ^ h4 & (h5 ^ h6)) + this._K[i48] | 0;
            h7 = h6;
            h6 = h5;
            h5 = h4;
            h4 = h3 + tmp;
            h3 = h2;
            h2 = h1;
            h1 = h0;
            h0 = tmp + (h1 & h2 ^ h3 & (h1 ^ h2)) + (h1 >>> 2 ^ h1 >>> 13 ^ h1 >>> 22 ^ h1 << 30 ^ h1 << 19 ^ h1 << 10) | 0;
        }
        h[0] = h[0] + h0 | 0;
        h[1] = h[1] + h1 | 0;
        h[2] = h[2] + h2 | 0;
        h[3] = h[3] + h3 | 0;
        h[4] = h[4] + h4 | 0;
        h[5] = h[5] + h5 | 0;
        h[6] = h[6] + h6 | 0;
        h[7] = h[7] + h7 | 0;
    }
}
function sha256(msg, inputEncoding, outputEncoding) {
    return new SHA256().update(msg, inputEncoding).digest(outputEncoding);
}
const lookup1 = [];
const revLookup1 = [];
const code1 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
for(let i1 = 0, l1 = code1.length; i1 < l1; ++i1){
    lookup1[i1] = code1[i1];
    revLookup1[code1.charCodeAt(i1)] = i1;
}
revLookup1["-".charCodeAt(0)] = 62;
revLookup1["_".charCodeAt(0)] = 63;
const { byteLength: byteLength1 , toUint8Array: toUint8Array1 , fromUint8Array: fromUint8Array1  } = init1(lookup1, revLookup1);
const decoder1 = new TextDecoder();
const encoder1 = new TextEncoder();
function toHexString1(buf) {
    return buf.reduce((hex, __byte)=>`${hex}${__byte < 16 ? "0" : ""}${__byte.toString(16)}`
    , "");
}
function fromHexString1(hex) {
    const len = hex.length;
    if (len % 2 || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new TypeError("Invalid hex string.");
    }
    hex = hex.toLowerCase();
    const buf = new Uint8Array(Math.floor(len / 2));
    const end = len / 2;
    for(let i49 = 0; i49 < end; ++i49){
        buf[i49] = parseInt(hex.substr(i49 * 2, 2), 16);
    }
    return buf;
}
function decode4(buf, encoding = "utf8") {
    if (/^utf-?8$/i.test(encoding)) {
        return decoder1.decode(buf);
    } else if (/^base64$/i.test(encoding)) {
        return fromUint8Array1(buf);
    } else if (/^base64url$/i.test(encoding)) {
        return fromUint8Array(buf);
    } else if (/^hex(?:adecimal)?$/i.test(encoding)) {
        return toHexString1(buf);
    } else {
        throw new TypeError("Unsupported string encoding.");
    }
}
function encode3(str, encoding = "utf8") {
    if (/^utf-?8$/i.test(encoding)) {
        return encoder1.encode(str);
    } else if (/^base64(?:url)?$/i.test(encoding)) {
        return toUint8Array1(str);
    } else if (/^hex(?:adecimal)?$/i.test(encoding)) {
        return fromHexString1(str);
    } else {
        throw new TypeError("Unsupported string encoding.");
    }
}
class SHA512 {
    hashSize = 64;
    _buffer = new Uint8Array(128);
    _bufferIndex;
    _count;
    _K;
    _H;
    _finalized;
    constructor(){
        this._K = new Uint32Array([
            1116352408,
            3609767458,
            1899447441,
            602891725,
            3049323471,
            3964484399,
            3921009573,
            2173295548,
            961987163,
            4081628472,
            1508970993,
            3053834265,
            2453635748,
            2937671579,
            2870763221,
            3664609560,
            3624381080,
            2734883394,
            310598401,
            1164996542,
            607225278,
            1323610764,
            1426881987,
            3590304994,
            1925078388,
            4068182383,
            2162078206,
            991336113,
            2614888103,
            633803317,
            3248222580,
            3479774868,
            3835390401,
            2666613458,
            4022224774,
            944711139,
            264347078,
            2341262773,
            604807628,
            2007800933,
            770255983,
            1495990901,
            1249150122,
            1856431235,
            1555081692,
            3175218132,
            1996064986,
            2198950837,
            2554220882,
            3999719339,
            2821834349,
            766784016,
            2952996808,
            2566594879,
            3210313671,
            3203337956,
            3336571891,
            1034457026,
            3584528711,
            2466948901,
            113926993,
            3758326383,
            338241895,
            168717936,
            666307205,
            1188179964,
            773529912,
            1546045734,
            1294757372,
            1522805485,
            1396182291,
            2643833823,
            1695183700,
            2343527390,
            1986661051,
            1014477480,
            2177026350,
            1206759142,
            2456956037,
            344077627,
            2730485921,
            1290863460,
            2820302411,
            3158454273,
            3259730800,
            3505952657,
            3345764771,
            106217008,
            3516065817,
            3606008344,
            3600352804,
            1432725776,
            4094571909,
            1467031594,
            275423344,
            851169720,
            430227734,
            3100823752,
            506948616,
            1363258195,
            659060556,
            3750685593,
            883997877,
            3785050280,
            958139571,
            3318307427,
            1322822218,
            3812723403,
            1537002063,
            2003034995,
            1747873779,
            3602036899,
            1955562222,
            1575990012,
            2024104815,
            1125592928,
            2227730452,
            2716904306,
            2361852424,
            442776044,
            2428436474,
            593698344,
            2756734187,
            3733110249,
            3204031479,
            2999351573,
            3329325298,
            3815920427,
            3391569614,
            3928383900,
            3515267271,
            566280711,
            3940187606,
            3454069534,
            4118630271,
            4000239992,
            116418474,
            1914138554,
            174292421,
            2731055270,
            289380356,
            3203993006,
            460393269,
            320620315,
            685471733,
            587496836,
            852142971,
            1086792851,
            1017036298,
            365543100,
            1126000580,
            2618297676,
            1288033470,
            3409855158,
            1501505948,
            4234509866,
            1607167915,
            987167468,
            1816402316,
            1246189591
        ]);
        this.init();
    }
    init() {
        this._H = new Uint32Array([
            1779033703,
            4089235720,
            3144134277,
            2227873595,
            1013904242,
            4271175723,
            2773480762,
            1595750129,
            1359893119,
            2917565137,
            2600822924,
            725511199,
            528734635,
            4215389547,
            1541459225,
            327033209
        ]);
        this._bufferIndex = 0;
        this._count = new Uint32Array(2);
        this._buffer.fill(0);
        this._finalized = false;
        return this;
    }
    update(msg, inputEncoding) {
        if (msg === null) {
            throw new TypeError("msg must be a string or Uint8Array.");
        } else if (typeof msg === "string") {
            msg = encode3(msg, inputEncoding);
        }
        for(let i50 = 0; i50 < msg.length; i50++){
            this._buffer[this._bufferIndex++] = msg[i50];
            if (this._bufferIndex === 128) {
                this.transform();
                this._bufferIndex = 0;
            }
        }
        let c = this._count;
        if ((c[0] += msg.length << 3) < msg.length << 3) {
            c[1]++;
        }
        c[1] += msg.length >>> 29;
        return this;
    }
    digest(outputEncoding) {
        if (this._finalized) {
            throw new Error("digest has already been called.");
        }
        this._finalized = true;
        var b = this._buffer, idx = this._bufferIndex;
        b[idx++] = 128;
        while(idx !== 112){
            if (idx === 128) {
                this.transform();
                idx = 0;
            }
            b[idx++] = 0;
        }
        let c = this._count;
        b[112] = b[113] = b[114] = b[115] = b[116] = b[117] = b[118] = b[119] = 0;
        b[120] = c[1] >>> 24 & 255;
        b[121] = c[1] >>> 16 & 255;
        b[122] = c[1] >>> 8 & 255;
        b[123] = c[1] >>> 0 & 255;
        b[124] = c[0] >>> 24 & 255;
        b[125] = c[0] >>> 16 & 255;
        b[126] = c[0] >>> 8 & 255;
        b[127] = c[0] >>> 0 & 255;
        this.transform();
        let i51, hash = new Uint8Array(64);
        for(i51 = 0; i51 < 16; i51++){
            hash[(i51 << 2) + 0] = this._H[i51] >>> 24 & 255;
            hash[(i51 << 2) + 1] = this._H[i51] >>> 16 & 255;
            hash[(i51 << 2) + 2] = this._H[i51] >>> 8 & 255;
            hash[(i51 << 2) + 3] = this._H[i51] & 255;
        }
        this.init();
        return outputEncoding ? decode4(hash, outputEncoding) : hash;
    }
    transform() {
        let h = this._H, h0h = h[0], h0l = h[1], h1h = h[2], h1l = h[3], h2h = h[4], h2l = h[5], h3h = h[6], h3l = h[7], h4h = h[8], h4l = h[9], h5h = h[10], h5l = h[11], h6h = h[12], h6l = h[13], h7h = h[14], h7l = h[15];
        let ah = h0h, al = h0l, bh = h1h, bl = h1l, ch = h2h, cl = h2l, dh = h3h, dl = h3l, eh = h4h, el = h4l, fh = h5h, fl = h5l, gh = h6h, gl = h6l, hh = h7h, hl = h7l;
        let i52, w = new Uint32Array(160);
        for(i52 = 0; i52 < 32; i52++){
            w[i52] = this._buffer[(i52 << 2) + 3] | this._buffer[(i52 << 2) + 2] << 8 | this._buffer[(i52 << 2) + 1] << 16 | this._buffer[i52 << 2] << 24;
        }
        let gamma0xl, gamma0xh, gamma0l, gamma0h, gamma1xl, gamma1xh, gamma1l, gamma1h, wrl, wrh, wr7l, wr7h, wr16l, wr16h;
        for(i52 = 16; i52 < 80; i52++){
            gamma0xh = w[(i52 - 15) * 2];
            gamma0xl = w[(i52 - 15) * 2 + 1];
            gamma0h = (gamma0xl << 31 | gamma0xh >>> 1) ^ (gamma0xl << 24 | gamma0xh >>> 8) ^ gamma0xh >>> 7;
            gamma0l = (gamma0xh << 31 | gamma0xl >>> 1) ^ (gamma0xh << 24 | gamma0xl >>> 8) ^ (gamma0xh << 25 | gamma0xl >>> 7);
            gamma1xh = w[(i52 - 2) * 2];
            gamma1xl = w[(i52 - 2) * 2 + 1];
            gamma1h = (gamma1xl << 13 | gamma1xh >>> 19) ^ (gamma1xh << 3 | gamma1xl >>> 29) ^ gamma1xh >>> 6;
            gamma1l = (gamma1xh << 13 | gamma1xl >>> 19) ^ (gamma1xl << 3 | gamma1xh >>> 29) ^ (gamma1xh << 26 | gamma1xl >>> 6);
            wr7h = w[(i52 - 7) * 2], wr7l = w[(i52 - 7) * 2 + 1], wr16h = w[(i52 - 16) * 2], wr16l = w[(i52 - 16) * 2 + 1];
            wrl = gamma0l + wr7l;
            wrh = gamma0h + wr7h + (wrl >>> 0 < gamma0l >>> 0 ? 1 : 0);
            wrl += gamma1l;
            wrh += gamma1h + (wrl >>> 0 < gamma1l >>> 0 ? 1 : 0);
            wrl += wr16l;
            wrh += wr16h + (wrl >>> 0 < wr16l >>> 0 ? 1 : 0);
            w[i52 * 2] = wrh;
            w[i52 * 2 + 1] = wrl;
        }
        let chl, chh, majl, majh, sig0l, sig0h, sig1l, sig1h, krl, krh, t1l, t1h, t2l, t2h;
        for(i52 = 0; i52 < 80; i52++){
            chh = eh & fh ^ ~eh & gh;
            chl = el & fl ^ ~el & gl;
            majh = ah & bh ^ ah & ch ^ bh & ch;
            majl = al & bl ^ al & cl ^ bl & cl;
            sig0h = (al << 4 | ah >>> 28) ^ (ah << 30 | al >>> 2) ^ (ah << 25 | al >>> 7);
            sig0l = (ah << 4 | al >>> 28) ^ (al << 30 | ah >>> 2) ^ (al << 25 | ah >>> 7);
            sig1h = (el << 18 | eh >>> 14) ^ (el << 14 | eh >>> 18) ^ (eh << 23 | el >>> 9);
            sig1l = (eh << 18 | el >>> 14) ^ (eh << 14 | el >>> 18) ^ (el << 23 | eh >>> 9);
            krh = this._K[i52 * 2];
            krl = this._K[i52 * 2 + 1];
            t1l = hl + sig1l;
            t1h = hh + sig1h + (t1l >>> 0 < hl >>> 0 ? 1 : 0);
            t1l += chl;
            t1h += chh + (t1l >>> 0 < chl >>> 0 ? 1 : 0);
            t1l += krl;
            t1h += krh + (t1l >>> 0 < krl >>> 0 ? 1 : 0);
            t1l = t1l + w[i52 * 2 + 1];
            t1h += w[i52 * 2] + (t1l >>> 0 < w[i52 * 2 + 1] >>> 0 ? 1 : 0);
            t2l = sig0l + majl;
            t2h = sig0h + majh + (t2l >>> 0 < sig0l >>> 0 ? 1 : 0);
            hh = gh;
            hl = gl;
            gh = fh;
            gl = fl;
            fh = eh;
            fl = el;
            el = dl + t1l | 0;
            eh = dh + t1h + (el >>> 0 < dl >>> 0 ? 1 : 0) | 0;
            dh = ch;
            dl = cl;
            ch = bh;
            cl = bl;
            bh = ah;
            bl = al;
            al = t1l + t2l | 0;
            ah = t1h + t2h + (al >>> 0 < t1l >>> 0 ? 1 : 0) | 0;
        }
        h0l = h[1] = h0l + al | 0;
        h[0] = h0h + ah + (h0l >>> 0 < al >>> 0 ? 1 : 0) | 0;
        h1l = h[3] = h1l + bl | 0;
        h[2] = h1h + bh + (h1l >>> 0 < bl >>> 0 ? 1 : 0) | 0;
        h2l = h[5] = h2l + cl | 0;
        h[4] = h2h + ch + (h2l >>> 0 < cl >>> 0 ? 1 : 0) | 0;
        h3l = h[7] = h3l + dl | 0;
        h[6] = h3h + dh + (h3l >>> 0 < dl >>> 0 ? 1 : 0) | 0;
        h4l = h[9] = h4l + el | 0;
        h[8] = h4h + eh + (h4l >>> 0 < el >>> 0 ? 1 : 0) | 0;
        h5l = h[11] = h5l + fl | 0;
        h[10] = h5h + fh + (h5l >>> 0 < fl >>> 0 ? 1 : 0) | 0;
        h6l = h[13] = h6l + gl | 0;
        h[12] = h6h + gh + (h6l >>> 0 < gl >>> 0 ? 1 : 0) | 0;
        h7l = h[15] = h7l + hl | 0;
        h[14] = h7h + hh + (h7l >>> 0 < hl >>> 0 ? 1 : 0) | 0;
    }
}
function sha512(msg, inputEncoding, outputEncoding) {
    return new SHA512().init().update(msg, inputEncoding).digest(outputEncoding);
}
function digest(algorithm, m) {
    if (algorithm === "sha1") {
        return sha1(m);
    } else if (algorithm === "sha256") {
        return sha256(m);
    } else if (algorithm === "sha512") {
        return sha512(m);
    }
    throw "Unsupport hash algorithm";
}
function digestLength(algorithm) {
    if (algorithm === "sha512") return 64;
    if (algorithm === "sha256") return 32;
    return 20;
}
function i2osp(x, length7) {
    const t = new Uint8Array(length7);
    for(let i53 = length7 - 1; i53 >= 0; i53--){
        if (x === 0n) break;
        t[i53] = Number(x & 255n);
        x = x >> 8n;
    }
    return t;
}
function os2ip(m) {
    let n = 0n;
    for (const c of m)n = (n << 8n) + BigInt(c);
    return n;
}
function mgf1(seed, length8, hash) {
    let counter = 0n;
    let output = [];
    while(output.length < length8){
        const c = i2osp(counter, 4);
        const h = new Uint8Array(digest(hash, new Uint8Array([
            ...seed,
            ...c
        ])));
        output = [
            ...output,
            ...h
        ];
        counter++;
    }
    return new Uint8Array(output.slice(0, length8));
}
function xor1(a, b) {
    const c = new Uint8Array(a.length);
    for(let i54 = 0; i54 < c.length; i54++){
        c[i54] = a[i54] ^ b[i54 % b.length];
    }
    return c;
}
function concat1(...arg) {
    const length9 = arg.reduce((a, b)=>a + b.length
    , 0);
    const c = new Uint8Array(length9);
    let ptr = 0;
    for(let i55 = 0; i55 < arg.length; i55++){
        c.set(arg[i55], ptr);
        ptr += arg[i55].length;
    }
    return c;
}
function random_bytes(length10) {
    const n = new Uint8Array(length10);
    for(let i56 = 0; i56 < length10; i56++)n[i56] = (Math.random() * 254 | 0) + 1;
    return n;
}
function get_key_size(n) {
    const size_list = [
        64n,
        128n,
        256n,
        512n,
        1024n
    ];
    for (const size of size_list){
        if (n < 1n << size * 8n) return Number(size);
    }
    return 2048;
}
function base64_to_binary(b) {
    let binaryString = window.atob(b);
    let len = binaryString.length;
    let bytes = new Uint8Array(len);
    for(var i57 = 0; i57 < len; i57++){
        bytes[i57] = binaryString.charCodeAt(i57);
    }
    return bytes;
}
function eme_oaep_encode(label, m, k, algorithm) {
    const labelHash = new Uint8Array(digest(algorithm, label));
    const ps = new Uint8Array(k - labelHash.length * 2 - 2 - m.length);
    const db = concat1(labelHash, ps, [
        1
    ], m);
    const seed = random_bytes(labelHash.length);
    const dbMask = mgf1(seed, k - labelHash.length - 1, algorithm);
    const maskedDb = xor1(db, dbMask);
    const seedMask = mgf1(maskedDb, labelHash.length, algorithm);
    const maskedSeed = xor1(seed, seedMask);
    return concat1([
        0
    ], maskedSeed, maskedDb);
}
function eme_oaep_decode(label, c, k, algorithm) {
    const labelHash = new Uint8Array(digest(algorithm, label));
    const maskedSeed = c.slice(1, 1 + labelHash.length);
    const maskedDb = c.slice(1 + labelHash.length);
    const seedMask = mgf1(maskedDb, labelHash.length, algorithm);
    const seed = xor1(maskedSeed, seedMask);
    const dbMask = mgf1(seed, k - labelHash.length - 1, algorithm);
    const db = xor1(maskedDb, dbMask);
    let ptr = labelHash.length;
    while(ptr < db.length && db[ptr] === 0)ptr++;
    return db.slice(ptr + 1);
}
function ber_decode(bytes, from, to) {
    return ber_next(bytes);
}
function ber_sequence(bytes, from, length11) {
    const end = from + length11;
    let res = [];
    let ptr = from;
    while(ptr < end){
        const next = ber_next(bytes, ptr);
        res.push(next);
        ptr += next.totalLength;
    }
    return res;
}
function ber_integer(bytes, from, length12) {
    let n = 0n;
    for (const b of bytes.slice(from, from + length12)){
        n = (n << 8n) + BigInt(b);
    }
    return n;
}
function ber_oid(bytes, from, length13) {
    const id = [
        bytes[from] / 40 | 0,
        bytes[from] % 40
    ];
    let value = 0;
    for (const b of bytes.slice(from + 1, from + length13)){
        if (b > 128) value += value * 127 + (b - 128);
        else {
            value = value * 128 + b;
            id.push(value);
            value = 0;
        }
    }
    return id.join(".");
}
function ber_unknown(bytes, from, length14) {
    return bytes.slice(from, from + length14);
}
function ber_simple(n) {
    if (Array.isArray(n.value)) return n.value.map((x)=>ber_simple(x)
    );
    return n.value;
}
function ber_next(bytes, from, to) {
    if (!from) from = 0;
    if (!to) to = bytes.length;
    let ptr = from;
    const type133 = bytes[ptr++];
    let size = bytes[ptr++];
    if ((size & 128) > 0) {
        let ext = size - 128;
        size = 0;
        while(--ext >= 0){
            size = (size << 8) + bytes[ptr++];
        }
    }
    let value = null;
    if (type133 === 48) {
        value = ber_sequence(bytes, ptr, size);
    } else if (type133 === 2) {
        value = ber_integer(bytes, ptr, size);
    } else if (type133 === 3) {
        value = ber_sequence(bytes, ptr + 1, size - 1);
    } else if (type133 === 5) {
        value = null;
    } else if (type133 === 6) {
        value = ber_oid(bytes, ptr, size);
    } else {
        value = ber_unknown(bytes, ptr, size);
    }
    return {
        totalLength: ptr - from + size,
        type: type133,
        length: size,
        value
    };
}
class RawBinary extends Uint8Array {
    hex() {
        return [
            ...this
        ].map((x)=>x.toString(16).padStart(2, "0")
        ).join("");
    }
    binary() {
        return this;
    }
    base64() {
        return btoa(String.fromCharCode.apply(null, [
            ...this
        ]));
    }
    base64url() {
        let a = btoa(String.fromCharCode.apply(null, [
            ...this
        ])).replace(/=/g, "");
        a = a.replace(/\+/g, "-");
        a = a.replace(/\//g, "_");
        return a;
    }
    base32() {
        const lookup3 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        const trim1 = [
            0,
            1,
            3,
            7,
            15,
            31,
            63,
            127,
            255
        ];
        let output = "";
        let bits = 0;
        let current = 0;
        for(let i58 = 0; i58 < this.length; i58++){
            current = (current << 8) + this[i58];
            bits += 8;
            while(bits >= 5){
                bits -= 5;
                output += lookup3[current >> bits];
                current = current & trim1[bits];
            }
        }
        if (bits > 0) {
            output += lookup3[current << 5 - bits];
        }
        return output;
    }
    toString() {
        return new TextDecoder().decode(this);
    }
}
function rsaep(n, e, m) {
    return power_mod(m, e, n);
}
function rsadp(key, c) {
    if (!key.d) throw "Invalid RSA key";
    if (key.dp && key.dq && key.qi && key.q && key.p) {
        const m1 = power_mod(c % key.p, key.dp, key.p);
        const m2 = power_mod(c % key.q, key.dq, key.q);
        let h = 0n;
        if (m1 >= m2) {
            h = key.qi * (m1 - m2) % key.p;
        } else {
            h = key.qi * (m1 - m2 + key.p * (key.p / key.q)) % key.p;
        }
        return (m2 + h * key.q) % (key.q * key.p);
    } else {
        return power_mod(c, key.d, key.n);
    }
}
function rsa_oaep_encrypt(bytes, n, e, m, algorithm) {
    const em = eme_oaep_encode(new Uint8Array(0), m, bytes, algorithm);
    const msg = os2ip(em);
    const c = rsaep(n, e, msg);
    return i2osp(c, bytes);
}
function rsa_oaep_decrypt(key, c, algorithm) {
    const em = rsadp(key, os2ip(c));
    const m = eme_oaep_decode(new Uint8Array(0), i2osp(em, key.length), key.length, algorithm);
    return m;
}
function rsa_pkcs1_encrypt(bytes, n, e, m) {
    const p = concat1([
        0,
        2
    ], random_bytes(bytes - m.length - 3), [
        0
    ], m);
    const msg = os2ip(p);
    const c = rsaep(n, e, msg);
    return i2osp(c, bytes);
}
function rsa_pkcs1_decrypt(key, c) {
    const em = i2osp(rsadp(key, os2ip(c)), key.length);
    if (em[0] !== 0) throw "Decryption error";
    if (em[1] !== 2) throw "Decryption error";
    let psCursor = 2;
    for(; psCursor < em.length; psCursor++){
        if (em[psCursor] === 0) break;
    }
    if (psCursor < 10) throw "Decryption error";
    return em.slice(psCursor + 1);
}
function rsa_pkcs1_verify(key, s, m) {
    if (!key.e) throw "Invalid RSA key";
    let em = i2osp(rsaep(key.n, key.e, os2ip(s)), key.length);
    if (em[0] !== 0) throw "Decryption error";
    if (em[1] !== 1) throw "Decryption error";
    let psCursor = 2;
    for(; psCursor < em.length; psCursor++){
        if (em[psCursor] === 0) break;
    }
    if (psCursor < 10) throw "Decryption error";
    em = em.slice(psCursor + 1);
    const ber = ber_simple(ber_decode(em));
    const decryptedMessage = ber[1];
    if (decryptedMessage.length !== m.length) return false;
    for(let i59 = 0; i59 < decryptedMessage.length; i59++){
        if (decryptedMessage[i59] !== m[i59]) return false;
    }
    return true;
}
function rsa_pkcs1_sign(bytes, n, d, message, algorithm) {
    const oid = [
        48,
        13,
        6,
        9,
        96,
        134,
        72,
        1,
        101,
        3,
        4,
        2,
        algorithm === "sha512" ? 3 : 1,
        5,
        0, 
    ];
    const der = [
        48,
        message.length + 2 + oid.length,
        ...oid,
        4,
        message.length,
        ...message, 
    ];
    const ps = new Array(bytes - 3 - der.length).fill(255);
    const em = new Uint8Array([
        0,
        1,
        ...ps,
        0,
        ...der
    ]);
    const msg = os2ip(em);
    const c = rsaep(n, d, msg);
    return new RawBinary(i2osp(c, bytes));
}
function emsa_pss_encode(m, emBits, sLen, algorithm) {
    const mHash = digest(algorithm, m);
    const hLen = mHash.length;
    const emLen = Math.ceil(emBits / 8);
    if (emLen < hLen + sLen + 2) throw "Encoding Error";
    const salt = new Uint8Array(sLen);
    crypto.getRandomValues(salt);
    const m1 = new Uint8Array([
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        ...mHash,
        ...salt
    ]);
    const h = digest(algorithm, m1);
    const ps = new Uint8Array(emLen - sLen - hLen - 2);
    const db = new Uint8Array([
        ...ps,
        1,
        ...salt
    ]);
    const dbMask = mgf1(h, emLen - hLen - 1, algorithm);
    const maskedDB = xor1(db, dbMask);
    const leftMost = 8 * emLen - emBits;
    maskedDB[0] = maskedDB[0] & 255 >> leftMost;
    return new Uint8Array([
        ...maskedDB,
        ...h,
        188
    ]);
}
function emsa_pss_verify(m, em, emBits, sLen, algorithm) {
    const mHash = digest(algorithm, m);
    const hLen = mHash.length;
    const emLen = Math.ceil(emBits / 8);
    if (emLen < hLen + sLen + 2) return false;
    if (em[em.length - 1] !== 188) return false;
    const maskedDB = em.slice(0, emLen - hLen - 1);
    const h = em.slice(emLen - hLen - 1, emLen - 1);
    const leftMost = 8 * emLen - emBits;
    if (maskedDB[0] >> 8 - leftMost != 0) return false;
    const dbMask = mgf1(h, emLen - hLen - 1, algorithm);
    const db = xor1(maskedDB, dbMask);
    db[0] = db[0] & 255 >> leftMost;
    for(let i60 = 1; i60 < emLen - hLen - sLen - 2; i60++){
        if (db[i60] !== 0) return false;
    }
    if (db[emLen - hLen - sLen - 2] !== 1) return false;
    const salt = db.slice(emLen - hLen - sLen - 1);
    const m1 = new Uint8Array([
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        ...mHash,
        ...salt
    ]);
    const h1 = digest(algorithm, m1);
    for(let i110 = 0; i110 < hLen; i110++){
        if (h1[i110] !== h[i110]) return false;
    }
    return true;
}
function rsassa_pss_sign(key, m, algorithm) {
    if (!key.d) throw "Invalid RSA Key";
    const hLen = digestLength(algorithm);
    let em = emsa_pss_encode(m, key.length * 8 - 1, hLen, algorithm);
    return new RawBinary(i2osp(rsaep(key.n, key.d, os2ip(em)), key.length));
}
function rsassa_pss_verify(key, m, signature, algorithm) {
    if (!key.e) throw "Invalid RSA Key";
    const hLen = digestLength(algorithm);
    const em = i2osp(rsaep(key.n, key.e, os2ip(signature)), key.length);
    return emsa_pss_verify(m, em, key.length * 8 - 1, hLen, algorithm);
}
class PureRSA {
    static async encrypt(key, message, options) {
        if (!key.e) throw "Invalid RSA key";
        if (options.padding === "oaep") {
            return new RawBinary(rsa_oaep_encrypt(key.length, key.n, key.e, message, options.hash));
        } else if (options.padding === "pkcs1") {
            return new RawBinary(rsa_pkcs1_encrypt(key.length, key.n, key.e, message));
        }
        throw "Invalid parameters";
    }
    static async decrypt(key, ciper, options) {
        if (!key.d) throw "Invalid RSA key";
        if (options.padding === "oaep") {
            return new RawBinary(rsa_oaep_decrypt(key, ciper, options.hash));
        } else if (options.padding === "pkcs1") {
            return new RawBinary(rsa_pkcs1_decrypt(key, ciper));
        }
        throw "Invalid parameters";
    }
    static async verify(key, signature, message, options) {
        if (!key.e) throw "Invalid RSA key";
        if (options.algorithm === "rsassa-pkcs1-v1_5") {
            return rsa_pkcs1_verify(key, signature, digest(options.hash, message));
        } else {
            return rsassa_pss_verify(key, message, signature, options.hash);
        }
    }
    static async sign(key, message, options) {
        if (!key.d) throw "You need private key to sign the message";
        if (options.algorithm === "rsassa-pkcs1-v1_5") {
            return rsa_pkcs1_sign(key.length, key.n, key.d, digest(options.hash, message), options.hash);
        } else {
            return rsassa_pss_sign(key, message, options.hash);
        }
    }
}
class encode4 {
    static hex(data) {
        if (data.length % 2 !== 0) throw "Invalid hex format";
        const output = new RawBinary(data.length >> 1);
        let ptr = 0;
        for(let i61 = 0; i61 < data.length; i61 += 2){
            output[ptr++] = parseInt(data.substr(i61, 2), 16);
        }
        return output;
    }
    static bigint(n) {
        const bytes = [];
        while(n > 0){
            bytes.push(Number(n & 255n));
            n = n >> 8n;
        }
        bytes.reverse();
        return new RawBinary(bytes);
    }
    static string(data) {
        return new RawBinary(new TextEncoder().encode(data));
    }
    static base64(data) {
        return new RawBinary(Uint8Array.from(atob(data), (c)=>c.charCodeAt(0)
        ));
    }
    static base64url(data) {
        let input = data.replace(/-/g, "+").replace(/_/g, "/");
        const pad1 = input.length % 4;
        if (pad1) {
            if (pad1 === 1) throw "Invalid length";
            input += new Array(5 - pad1).join("=");
        }
        return encode4.base64(input);
    }
    static binary(data) {
        return new RawBinary(data);
    }
    static base32(data) {
        data = data.toUpperCase();
        data = data.replace(/=+$/g, "");
        const lookup4 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        const size = data.length * 5 >> 3;
        const output = new RawBinary(size);
        let ptr = 0;
        let bits = 0;
        let current = 0;
        for(let i62 = 0; i62 < data.length; i62++){
            const value = lookup4.indexOf(data[i62]);
            if (value < 0) throw "Invalid base32 format";
            current = (current << 5) + value;
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                const t = current >> bits;
                current -= t << bits;
                output[ptr++] = t;
            }
        }
        return output;
    }
}
function detect_format(key) {
    if (typeof key === "object") {
        if (key.kty === "RSA") return "jwk";
    } else if (typeof key === "string") {
        if (key.substr(0, "-----".length) === "-----") return "pem";
    }
    throw new TypeError("Unsupported key format");
}
function rsa_import_jwk(key) {
    if (typeof key !== "object") throw new TypeError("Invalid JWK format");
    if (!key.n) throw new TypeError("RSA key requires n");
    const n = os2ip(encode4.base64url(key.n));
    return {
        e: key.e ? os2ip(encode4.base64url(key.e)) : undefined,
        n: os2ip(encode4.base64url(key.n)),
        d: key.d ? os2ip(encode4.base64url(key.d)) : undefined,
        p: key.p ? os2ip(encode4.base64url(key.p)) : undefined,
        q: key.q ? os2ip(encode4.base64url(key.q)) : undefined,
        dp: key.dp ? os2ip(encode4.base64url(key.dp)) : undefined,
        dq: key.dq ? os2ip(encode4.base64url(key.dq)) : undefined,
        qi: key.qi ? os2ip(encode4.base64url(key.qi)) : undefined,
        length: get_key_size(n)
    };
}
function rsa_import_pem_cert(key) {
    const trimmedKey = key.substr(27, key.length - 53);
    const parseKey = ber_simple(ber_decode(base64_to_binary(trimmedKey)));
    return {
        length: get_key_size(parseKey[0][5][1][0][0]),
        n: parseKey[0][5][1][0][0],
        e: parseKey[0][5][1][0][1]
    };
}
function rsa_import_pem_private(key) {
    const trimmedKey = key.substr(31, key.length - 61);
    const parseKey = ber_simple(ber_decode(base64_to_binary(trimmedKey)));
    return {
        n: parseKey[1],
        d: parseKey[3],
        e: parseKey[2],
        p: parseKey[4],
        q: parseKey[5],
        dp: parseKey[6],
        dq: parseKey[7],
        qi: parseKey[8],
        length: get_key_size(parseKey[1])
    };
}
function rsa_import_pem_private_pkcs8(key) {
    const trimmedKey = key.substr(27, key.length - 57);
    const parseWrappedKey = ber_simple(ber_decode(base64_to_binary(trimmedKey)));
    const parseKey = ber_simple(ber_decode(parseWrappedKey[2]));
    return {
        n: parseKey[1],
        d: parseKey[3],
        e: parseKey[2],
        p: parseKey[4],
        q: parseKey[5],
        dp: parseKey[6],
        dq: parseKey[7],
        qi: parseKey[8],
        length: get_key_size(parseKey[1])
    };
}
function rsa_import_pem_public(key) {
    const trimmedKey = key.substr(26, key.length - 51);
    const parseKey = ber_simple(ber_decode(base64_to_binary(trimmedKey)));
    return {
        length: get_key_size(parseKey[1][0][0]),
        n: parseKey[1][0][0],
        e: parseKey[1][0][1]
    };
}
function rsa_import_pem(key) {
    if (typeof key !== "string") throw new TypeError("PEM key must be string");
    const trimmedKey = key.trim();
    const maps = [
        [
            "-----BEGIN RSA PRIVATE KEY-----",
            rsa_import_pem_private
        ],
        [
            "-----BEGIN PRIVATE KEY-----",
            rsa_import_pem_private_pkcs8
        ],
        [
            "-----BEGIN PUBLIC KEY-----",
            rsa_import_pem_public
        ],
        [
            "-----BEGIN CERTIFICATE-----",
            rsa_import_pem_cert
        ], 
    ];
    for (const [prefix, func] of maps){
        if (trimmedKey.indexOf(prefix) === 0) return func(trimmedKey);
    }
    throw new TypeError("Unsupported key format");
}
function rsa_import_key(key, format) {
    const finalFormat = format === "auto" ? detect_format(key) : format;
    if (finalFormat === "jwk") return rsa_import_jwk(key);
    if (finalFormat === "pem") return rsa_import_pem(key);
    throw new TypeError("Unsupported key format");
}
function createSizeBuffer(size) {
    if (size <= 127) return new Uint8Array([
        size
    ]);
    const bytes = [];
    while(size > 0){
        bytes.push(size & 255);
        size = size >> 8;
    }
    bytes.reverse();
    return new Uint8Array([
        128 + bytes.length,
        ...bytes
    ]);
}
class BER {
    static createSequence(children) {
        const size = children.reduce((accumlatedSize, child)=>accumlatedSize + child.length
        , 0);
        return new Uint8Array([
            48,
            ...createSizeBuffer(size),
            ...children.reduce((buffer, child)=>[
                    ...buffer,
                    ...child
                ]
            , []), 
        ]);
    }
    static createNull() {
        return new Uint8Array([
            5,
            0
        ]);
    }
    static createBoolean(value) {
        return new Uint8Array([
            1,
            1,
            value ? 1 : 0
        ]);
    }
    static createInteger(value) {
        if (typeof value === "number") return BER.createBigInteger(BigInt(value));
        return BER.createBigInteger(value);
    }
    static createBigInteger(value) {
        if (value === 0n) return new Uint8Array([
            2,
            1,
            0
        ]);
        const isNegative = value < 0;
        const content = [];
        let n = isNegative ? -value : value;
        while(n > 0n){
            content.push(Number(n & 255n));
            n = n >> 8n;
        }
        if (!isNegative) {
            if (content[content.length - 1] & 128) content.push(0);
        } else {
            for(let i63 = 0; i63 < content.length; i63++)content[i63] = 256 - content[i63];
            if (!(content[content.length - 1] & 128)) content.push(255);
        }
        content.reverse();
        return new Uint8Array([
            2,
            ...createSizeBuffer(content.length),
            ...content, 
        ]);
    }
    static createBitString(value) {
        return new Uint8Array([
            3,
            ...createSizeBuffer(value.length + 1),
            0,
            ...value, 
        ]);
    }
}
function add_line_break(base64_str) {
    const lines = [];
    for(let i64 = 0; i64 < base64_str.length; i64 += 64){
        lines.push(base64_str.substr(i64, 64));
    }
    return lines.join("\n");
}
function rsa_export_pkcs8_public(key) {
    const content = BER.createSequence([
        BER.createSequence([
            new Uint8Array([
                6,
                9,
                42,
                134,
                72,
                134,
                247,
                13,
                1,
                1,
                1, 
            ]),
            BER.createNull(), 
        ]),
        BER.createBitString(BER.createSequence([
            BER.createInteger(key.n),
            BER.createInteger(key.e || 0n), 
        ])), 
    ]);
    return "-----BEGIN PUBLIC KEY-----\n" + add_line_break(encode4.binary(content).base64()) + "\n-----END PUBLIC KEY-----\n";
}
function rsa_export_pkcs8_private(key) {
    const content = BER.createSequence([
        BER.createInteger(0),
        BER.createInteger(key.n),
        BER.createInteger(key.e || 0n),
        BER.createInteger(key.d || 0n),
        BER.createInteger(key.p || 0n),
        BER.createInteger(key.q || 0n),
        BER.createInteger(key.dp || 0n),
        BER.createInteger(key.dq || 0n),
        BER.createInteger(key.qi || 0n), 
    ]);
    const ber = encode4.binary(content).base64();
    return "-----BEGIN RSA PRIVATE KEY-----\n" + add_line_break(ber) + "\n-----END RSA PRIVATE KEY-----\n";
}
class RSAKey {
    n;
    e;
    d;
    p;
    q;
    dp;
    dq;
    qi;
    length;
    constructor(params){
        this.n = params.n;
        this.e = params.e;
        this.d = params.d;
        this.p = params.p;
        this.q = params.q;
        this.dp = params.dp;
        this.dq = params.dq;
        this.qi = params.qi;
        this.length = params.length;
    }
    pem() {
        if (this.d) {
            return rsa_export_pkcs8_private(this);
        } else {
            return rsa_export_pkcs8_public(this);
        }
    }
    jwk() {
        let jwk = {
            kty: "RSA",
            n: encode4.bigint(this.n).base64url()
        };
        if (this.d) jwk = {
            ...jwk,
            d: encode4.bigint(this.d).base64url()
        };
        if (this.e) jwk = {
            ...jwk,
            e: encode4.bigint(this.e).base64url()
        };
        if (this.p) jwk = {
            ...jwk,
            p: encode4.bigint(this.p).base64url()
        };
        if (this.q) jwk = {
            ...jwk,
            q: encode4.bigint(this.q).base64url()
        };
        if (this.dp) jwk = {
            ...jwk,
            dp: encode4.bigint(this.dp).base64url()
        };
        if (this.dq) jwk = {
            ...jwk,
            dq: encode4.bigint(this.dq).base64url()
        };
        if (this.qi) jwk = {
            ...jwk,
            qi: encode4.bigint(this.qi).base64url()
        };
        return jwk;
    }
}
function computeMessage(m) {
    return typeof m === "string" ? new TextEncoder().encode(m) : m;
}
function computeOption(options) {
    return {
        hash: "sha1",
        padding: "oaep",
        ...options
    };
}
class RSA {
    key;
    constructor(key){
        this.key = key;
    }
    async encrypt(m, options) {
        const computedOption = computeOption(options);
        const func = WebCryptoRSA.isSupported(computedOption) ? WebCryptoRSA.encrypt : PureRSA.encrypt;
        return new RawBinary(await func(this.key, computeMessage(m), computedOption));
    }
    async decrypt(m, options) {
        const computedOption = computeOption(options);
        const func = WebCryptoRSA.isSupported(computedOption) ? WebCryptoRSA.decrypt : PureRSA.decrypt;
        return new RawBinary(await func(this.key, m, computedOption));
    }
    async verify(signature, message, options) {
        const computedOption = {
            algorithm: "rsassa-pkcs1-v1_5",
            hash: "sha256",
            ...options
        };
        return await PureRSA.verify(this.key, signature, computeMessage(message), computedOption);
    }
    async sign(message, options) {
        const computedOption = {
            algorithm: "rsassa-pkcs1-v1_5",
            hash: "sha256",
            ...options
        };
        return await PureRSA.sign(this.key, computeMessage(message), computedOption);
    }
    static parseKey(key, format = "auto") {
        return this.importKey(key, format);
    }
    static importKey(key, format = "auto") {
        return new RSAKey(rsa_import_key(key, format));
    }
}
function assertNever(alg, message) {
    throw new RangeError(message);
}
function convertHexToBase64url(input) {
    return mod1.encode(decodeString(input));
}
async function encrypt(algorithm, key, message) {
    switch(algorithm){
        case "none":
            return "";
        case "HS256":
            return new HmacSha256(key).update(message).toString();
        case "HS512":
            return new HmacSha512(key).update(message).toString();
        case "RS256":
            return (await new RSA(RSA.parseKey(key)).sign(message, {
                algorithm: "rsassa-pkcs1-v1_5",
                hash: "sha256"
            })).hex();
        case "RS512":
            return (await new RSA(RSA.parseKey(key)).sign(message, {
                algorithm: "rsassa-pkcs1-v1_5",
                hash: "sha512"
            })).hex();
        case "PS256":
            return (await new RSA(RSA.parseKey(key)).sign(message, {
                algorithm: "rsassa-pss",
                hash: "sha256"
            })).hex();
        case "PS512":
            return (await new RSA(RSA.parseKey(key)).sign(message, {
                algorithm: "rsassa-pss",
                hash: "sha512"
            })).hex();
        default:
            assertNever(algorithm, "no matching crypto algorithm in the header: " + algorithm);
    }
}
async function create2(algorithm, key, input) {
    return convertHexToBase64url(await encrypt(algorithm, key, input));
}
const encoder2 = new TextEncoder();
new TextDecoder();
function createSigningInput(header, payload) {
    return `${mod1.encode(encoder2.encode(JSON.stringify(header)))}.${mod1.encode(encoder2.encode(JSON.stringify(payload)))}`;
}
async function create3(header, payload, key) {
    const signingInput = createSigningInput(header, payload);
    const signature = await create2(header.alg, key, signingInput);
    return `${signingInput}.${signature}`;
}
const { lensPath: lensPath1 , set: set2  } = mod;
const service2 = "search";
const add3 = (key, doc)=>(hyper14)=>hyper14({
            service: service2,
            method: Method.POST,
            body: {
                key,
                doc
            }
        })
;
const remove3 = (key)=>(hyper15)=>hyper15({
            service: service2,
            method: Method.DELETE,
            resource: key
        })
;
const get2 = (key)=>(hyper16)=>hyper16({
            service: service2,
            method: Method.GET,
            resource: key
        })
;
const update2 = (key, doc)=>(hyper17)=>hyper17({
            service: service2,
            method: Method.PUT,
            resource: key,
            body: doc
        })
;
const query2 = (query11, options)=>(hyper18)=>hyper18([
            {
                service: service2,
                method: Method.POST,
                action: Action.QUERY,
                body: {
                    query: query11
                }
            }
        ].map((r)=>options && options.fields ? set2(lensPath1([
                "body",
                "fields"
            ]), options.fields, r) : r
        ).map((r)=>options && options.filter ? set2(lensPath1([
                "body",
                "filter"
            ]), options.filter, r) : r
        )[0])
;
const load = (docs)=>(hyper19)=>hyper19({
            service: service2,
            method: Method.POST,
            action: Action.BULK,
            body: docs
        })
;
const create4 = (fields, storeFields)=>(hyper20)=>hyper20({
            service: service2,
            method: Method.PUT,
            body: {
                fields,
                storeFields
            }
        })
;
const destroy2 = (confirm = true)=>(hyper21)=>confirm ? hyper21({
            service: service2,
            method: Method.DELETE
        }) : Promise.reject({
            ok: false,
            msg: "request not confirmed!"
        })
;
const service3 = "info";
const services = ()=>(h)=>h({
            service: service3,
            method: Method.GET
        })
;
const { assoc: assoc1  } = mod;
const generateToken = (sub, secret)=>{
    const exp = Math.floor(Date.now() / 1000) + 60 * 5;
    return create3({
        alg: "HS256",
        type: "JWT"
    }, {
        sub: sub,
        exp
    }, secret);
};
const hyper = (conn, domain)=>async ({ service: service4 , method , resource , body , params , action  })=>{
        const isCloud = /^cloud/.test(conn.protocol);
        const protocol = isCloud ? "https:" : conn.protocol;
        let options = {
            headers: new Headers({
                "Content-Type": "application/json"
            }),
            method: method ? method : Method.GET
        };
        if (body) {
            options = assoc1("body", JSON.stringify(body), options);
        }
        if (conn.username && conn.password) {
            const token = await generateToken(conn.username, conn.password);
            options.headers = new Headers({
                ...Object.fromEntries(options.headers.entries()),
                Authorization: `Bearer ${token}`
            });
        }
        const pathname = isCloud ? conn.pathname : "";
        const appdomain = isCloud ? "/" + domain : conn.pathname;
        let url = `${protocol}//${conn.host}${pathname}/${service4}${appdomain}`;
        if (service4 === "info") {
            url = `${protocol}//${conn.host}`;
        }
        if (resource) url += `/${resource}`;
        else if (action) url += `/${action}`;
        if (params) {
            url += `?${new URLSearchParams(params).toString()}`;
        }
        return {
            url,
            options
        };
    }
;
const { assoc: assoc2 , includes: includes1 , ifElse: ifElse1  } = mod;
function connect(CONNECTION_STRING, domain = "default") {
    const config = new URL(CONNECTION_STRING);
    const h = async (hyperRequest)=>{
        const { url , options  } = await hyper(config, domain)(hyperRequest);
        return new Request(url, options);
    };
    const handleResponse = (response)=>Promise.resolve(response).then(ifElse1((r)=>includes1("application/json", r.headers.get("content-type"))
        , (r)=>r.json()
        , (r)=>r.text().then((msg)=>({
                    ok: r.ok,
                    msg
                })
            )
        )).then((r)=>response.ok ? r : assoc2("status", response.status, r)
        ).then((r)=>response.status >= 500 ? Promise.reject(r) : r
        )
    ;
    return {
        data: {
            add: (body)=>Promise.resolve(h).then(add(body)).then(fetch).then(handleResponse)
            ,
            get: (id)=>Promise.resolve(h).then(get(id)).then(fetch).then(handleResponse)
            ,
            list: (options)=>Promise.resolve(h).then(list(options)).then(fetch).then(handleResponse)
            ,
            update: (id, doc)=>Promise.resolve(h).then(update(id, doc)).then(fetch).then(handleResponse)
            ,
            remove: (id)=>Promise.resolve(h).then(remove(id)).then(fetch).then(handleResponse)
            ,
            query: (selector, options)=>Promise.resolve(h).then(query(selector, options)).then(fetch).then(handleResponse)
            ,
            bulk: (docs)=>Promise.resolve(h).then(bulk(docs)).then(fetch).then(handleResponse)
            ,
            index: (indexName, fields)=>Promise.resolve(h).then(index(indexName, fields)).then(fetch).then(handleResponse)
            ,
            create: ()=>Promise.resolve(h).then(create()).then(fetch).then(handleResponse)
            ,
            destroy: (confirm)=>Promise.resolve(h).then(destroy(confirm)).then(fetch).then(handleResponse)
        },
        cache: {
            add: (key, value, ttl)=>Promise.resolve(h).then(add1(key, value, ttl)).then(fetch).then(handleResponse)
            ,
            get: (key)=>Promise.resolve(h).then(get1(key)).then(fetch).then(handleResponse)
            ,
            remove: (key)=>Promise.resolve(h).then(remove1(key)).then(fetch).then(handleResponse)
            ,
            set: (key, value, ttl)=>Promise.resolve(h).then(set(key, value, ttl)).then(fetch).then(handleResponse)
            ,
            query: (pattern)=>Promise.resolve(h).then(query1(pattern)).then(fetch).then(handleResponse)
            ,
            create: ()=>Promise.resolve(h).then(create1()).then(fetch).then(handleResponse)
            ,
            destroy: (confirm)=>Promise.resolve(h).then(destroy1(confirm)).then(fetch).then(handleResponse)
        },
        search: {
            add: (key, doc)=>Promise.resolve(h).then(add3(key, doc)).then(fetch).then(handleResponse)
            ,
            remove: (key)=>Promise.resolve(h).then(remove3(key)).then(fetch).then(handleResponse)
            ,
            get: (key)=>Promise.resolve(h).then(get2(key)).then(fetch).then(handleResponse)
            ,
            update: (key, doc)=>Promise.resolve(h).then(update2(key, doc)).then(fetch).then(handleResponse)
            ,
            query: (query6, options)=>Promise.resolve(h).then(query2(query6, options)).then(fetch).then(handleResponse)
            ,
            load: (docs)=>Promise.resolve(h).then(load(docs)).then(fetch).then(handleResponse)
            ,
            create: (fields, storeFields)=>Promise.resolve(h).then(create4(fields, storeFields)).then(fetch).then(handleResponse)
            ,
            destroy: (confirm)=>Promise.resolve(h).then(destroy2(confirm)).then(fetch).then(handleResponse)
        },
        info: {
            services: ()=>Promise.resolve(h).then(services()).then(fetch).then(handleResponse)
        }
    };
}
const hyper1 = connect(Deno.env.get('HYPER'));
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
const resolvers = {
    Query: {
        shortcut: async (_parent, { code: code17  })=>await hyper1.data.get(code17)
    },
    Mutation: {
        createShortcut (_parent, { code: code18 , href  }) {
            return hyper1.data.add({
                _id: code18,
                code: code18,
                href
            });
        }
    }
};
const graphql1 = async (req)=>await GraphQLHTTP({
        schema: makeExecutableSchema({
            resolvers,
            typeDefs
        }),
        graphiql: true
    })(req)
;
const shortcut = async (code19)=>{
    const result = await hyper1.data.get(code19);
    return result?.href;
};
const GQL = new URLPattern({
    pathname: '/graphql'
});
const INDEX = new URLPattern({
    pathname: '/'
});
const GOTO = new URLPattern({
    pathname: '/:code'
});
serve(async (req)=>{
    if (GQL.test(req.url)) {
        return graphql1(req);
    }
    if (INDEX.test(req.url)) {
        return new Response(`<h1>URL Shortener App</h1>`, {
            headers: {
                'Content-Type': 'text/html'
            }
        });
    }
    if (GOTO.test(req.url)) {
        const code20 = GOTO.exec(req.url)?.pathname?.groups?.code;
        if (code20) {
            return Response.redirect(await shortcut(code20));
        }
    }
    return new Response('Not Found!', {
        status: 404
    });
});
