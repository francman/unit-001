// Minimal file contents for persistent web release and updater admission tests.
export const webApplicationFiles = {
	"app/package.json": '{"type":"module"}',
	"app/dist/bin.js": "// standalone entrypoint",
	"app/dist/cli.js": "// shared command entrypoint",
	"app/dist/named.js": 'import "./web/launcher.js";',
	"app/dist/service-client.js": "// transitive gateway import",
	"app/dist/web/contract.js": "// browser request contract",
	"app/dist/web/launcher.js": 'import "../service-client.js";',
	"app/dist/web/gateway.js": "// web gateway",
	"app/dist/web/inherited-listener.js": "// inherited listener",
	"app/dist/web/listener-lock.js": "// foreground listener lock",
	"app/dist/web/listener-residue.js": "// foreground listener recovery",
	"app/dist/web/post-response.js": "// browser mutation responses",
	"app/web-dist/index.html": "<!doctype html>",
	"app/web-dist/bootstrap.js": "// browser entrypoint",
	"app/web-dist/style.css": "/* browser styles */",
};

export const webUpdaterPackages = {
	"node_modules/@tufjs/models/package.json": '{"name":"@tufjs/models","main":"dist/index.js"}',
	"node_modules/@tufjs/models/dist/index.js": 'exports.Metadata = require("./base.js");',
	"node_modules/@tufjs/models/dist/base.js": "module.exports = class {};",
	"node_modules/tuf-js/package.json": '{"name":"tuf-js","main":"dist/index.js"}',
	"node_modules/tuf-js/dist/index.js": "exports.Updater = class {};",
	"node_modules/tuf-js/dist/error.js": "exports.DownloadHTTPError = class extends Error {};",
};
