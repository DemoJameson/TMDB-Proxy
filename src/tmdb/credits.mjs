const MAX_DIRECTORS = 2;

function joinCreditValues(items, key) {
	return (Array.isArray(items) ? items : [])
		.map(item => item?.[key])
		.filter(value => typeof value === "string" && value.length > 0)
		.join(" / ");
}

function normalizeAggregateCast(item) {
	const { roles: _roles, total_episode_count: _episodeCount, ...cast } = item ?? {};
	const character = joinCreditValues(item?.roles, "character");
	if (character) cast.character = character;
	return cast;
}

// 将 aggregate_credits 的 crew 条目展开为普通 credits 格式：每个 job 一条记录。
// Expands aggregate_credits crew entries into regular credits format: one entry per job.
function normalizeAggregateCrew(item) {
	const { jobs, total_episode_count: _episodeCount, ...crew } = item ?? {};
	if (!Array.isArray(jobs) || jobs.length === 0) return [crew];
	const entries = jobs
		.filter(job => typeof job?.job === "string" && job.job.length > 0)
		.map(job => {
			const entry = { ...crew, job: job.job };
			if (job.credit_id) entry.credit_id = job.credit_id;
			return entry;
		});
	return entries.length > 0 ? entries : [crew];
}

// 计算导演导过的集数，用于排序重要性。
// Sums episode_count from Director jobs to rank importance.
function getDirectorEpisodeCount(item) {
	if (!Array.isArray(item?.jobs)) return 0;
	return item.jobs.reduce((sum, job) => (job?.job === "Director" ? sum + (Number(job.episode_count) || 0) : sum), 0);
}

function isDirector(item) {
	return Array.isArray(item?.jobs) && item.jobs.some(job => job?.job === "Director");
}

function hasProfilePath(item) {
	return typeof item?.profile_path === "string" && item.profile_path.length > 0;
}

// 限制导演数量：按导过的集数降序取前 MAX_DIRECTORS 个，过滤掉无头像的，至少保留一个。
// Limits directors: takes top 2 by episode count (desc), filters out those without profile photos, keeps at least one.
function limitDirectors(crew) {
	if (!Array.isArray(crew)) return crew;
	const directors = crew.filter(isDirector);
	if (directors.length <= MAX_DIRECTORS) return crew;
	const sorted = directors.sort((a, b) => getDirectorEpisodeCount(b) - getDirectorEpisodeCount(a));
	const topDirectors = sorted.slice(0, MAX_DIRECTORS);
	const withProfile = topDirectors.filter(hasProfilePath);
	// 至少保留一个导演：有头像的为空时回退到集数最多的那位。
	// Keep at least one director: fall back to top director when none have profile photos.
	const kept = withProfile.length > 0 ? withProfile : [sorted[0]];
	const keep = new Set(kept.map(item => item?.id));
	return crew.filter(item => !isDirector(item) || keep.has(item?.id));
}

function normalizeAggregateCredits(body) {
	if (!body || typeof body !== "object") return body;
	return {
		...body,
		...(Array.isArray(body.cast) ? { cast: body.cast.map(normalizeAggregateCast) } : {}),
		...(Array.isArray(body.crew) ? { crew: limitDirectors(body.crew).flatMap(normalizeAggregateCrew) } : {}),
	};
}

export { normalizeAggregateCredits };
