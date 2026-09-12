export default function install(pi) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.model) Object.freeze(ctx.model);
	});
}
