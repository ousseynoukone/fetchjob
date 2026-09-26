"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApplicationsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../common/prisma.service");
const local_user_service_1 = require("../common/local-user.service");
const cv_service_1 = require("../cv/cv.service");
const matching_service_1 = require("../matching/matching.service");
const campaign_service_1 = require("../campaign/campaign.service");
const application_prep_service_1 = require("./application-prep.service");
const crypto_1 = require("crypto");
// Statuses that imply a real submission happened at some point (auto-apply
// success or manual "Marquer comme postulée") — used to keep
// Campaign.totalApplicationsSent accurate when candidatures are deleted.
// 'to_apply', 'needs_review' and 'ignored' never reached that point.
const SENT_STATUSES = ['applied', 'interview', 'offer', 'rejected'];
let ApplicationsService = class ApplicationsService {
    constructor(prisma, localUser, cvService, matching, campaignService, prep) {
        this.prisma = prisma;
        this.localUser = localUser;
        this.cvService = cvService;
        this.matching = matching;
        this.campaignService = campaignService;
        this.prep = prep;
    }
    // `scope` only matters for the to_apply status: 'current' keeps the "À
    // postuler" list to what the latest campaign run actually surfaced (plus
    // anything with no run at all — manual offers, or candidatures prepared
    // before campaignRunId existed), 'history' shows what got left behind by
    // an older run instead. Every other status ignores it — once you've acted
    // on a candidature (applied/interview/...), it stays visible regardless
    // of which run produced it. Shared by list() and removeAll() so "delete
    // this tab" always matches exactly what that tab is showing.
    async buildStatusScopeFilter(userId, status, scope) {
        let runFilter = {};
        if (status === 'to_apply' && scope) {
            const latestRun = await this.campaignService.getLatestRun();
            const latestRunId = latestRun?.id;
            runFilter = scope === 'history'
                ? { campaignRunId: latestRunId ? { not: latestRunId } : { not: null } }
                : { OR: [{ campaignRunId: null }, ...(latestRunId ? [{ campaignRunId: latestRunId }] : [])] };
        }
        return { userId, ...(status ? { status } : {}), ...runFilter };
    }
    async list(status, scope) {
        const userId = await this.localUser.getDefaultUserId();
        const where = await this.buildStatusScopeFilter(userId, status, scope);
        return this.prisma.application.findMany({
            where,
            include: { jobOffer: true },
            omit: { screenshot: true, verificationScreenshot: true },
            orderBy: { createdAt: 'desc' },
        });
    }
    // Keeps Campaign.totalApplicationsPrepared/totalApplicationsSent accurate
    // after a delete — without this, those counters (shown on the Campagne
    // page) keep counting rows that no longer exist, drifting further from
    // reality with every cleanup. Grouped by campaign in case more than one
    // exists, though in practice this tool only ever has the one.
    async decrementCampaignStats(deleted) {
        if (!deleted.length)
            return;
        const byCampaign = new Map();
        for (const row of deleted) {
            const entry = byCampaign.get(row.campaignId) || { prepared: 0, sent: 0 };
            entry.prepared += 1;
            if (SENT_STATUSES.includes(row.status))
                entry.sent += 1;
            byCampaign.set(row.campaignId, entry);
        }
        for (const [campaignId, counts] of byCampaign) {
            const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
            if (!campaign)
                continue;
            await this.prisma.campaign.update({
                where: { id: campaignId },
                data: {
                    // Clamped via Math.min rather than a raw decrement: stats that
                    // predate this fix (or drifted for any other reason) could
                    // otherwise go negative.
                    totalApplicationsPrepared: { decrement: Math.min(counts.prepared, campaign.totalApplicationsPrepared) },
                    totalApplicationsSent: { decrement: Math.min(counts.sent, campaign.totalApplicationsSent) },
                },
            });
        }
    }
    async getById(id) {
        const application = await this.prisma.application.findUnique({
            where: { id },
            include: { jobOffer: true },
            omit: { screenshot: true, verificationScreenshot: true },
        });
        if (!application) {
            throw new common_1.NotFoundException('Application not found');
        }
        return application;
    }
    // The screenshot itself is only ever fetched through its own binary
    // endpoint (see ApplicationsController) — kept out of list()/getById() so
    // an ordinary candidature fetch never drags a ~100-200KB image along.
    async getScreenshot(id) {
        const application = await this.prisma.application.findUnique({
            where: { id },
            select: { screenshot: true },
        });
        return application?.screenshot ?? null;
    }
    // Same reasoning as getScreenshot() above, for the separate screenshot a
    // Vérification pass captures — a different moment (does the platform now
    // show this as recorded?) from the apply-time one, so kept as its own
    // field rather than overwriting it.
    async getVerificationScreenshot(id) {
        const application = await this.prisma.application.findUnique({
            where: { id },
            select: { verificationScreenshot: true },
        });
        return application?.verificationScreenshot ?? null;
    }
    async updateStatus(id, status) {
        await this.getById(id);
        return this.prisma.application.update({
            where: { id },
            data: { status },
            include: { jobOffer: true },
            omit: { screenshot: true, verificationScreenshot: true },
        });
    }
    async updateTracking(id, dto) {
        await this.getById(id);
        const data = {};
        if (dto.status !== undefined) data.status = dto.status;
        if ('interviewDate' in dto) data.interviewDate = dto.interviewDate ? new Date(dto.interviewDate) : null;
        if ('interviewType' in dto) data.interviewType = dto.interviewType ?? null;
        if ('rejectedAt' in dto) data.rejectedAt = dto.rejectedAt ? new Date(dto.rejectedAt) : null;
        if ('offerSalary' in dto) data.offerSalary = dto.offerSalary ?? null;
        if ('feedbackNote' in dto) data.feedbackNote = dto.feedbackNote ?? null;
        if (dto.status === 'rejected' && !data.rejectedAt) {
            data.rejectedAt = new Date();
        }
        if (dto.status === 'applied') {
            data.interviewDate = null;
            data.interviewType = null;
            data.rejectedAt = null;
        }
        return this.prisma.application.update({
            where: { id },
            data,
            include: { jobOffer: true },
            omit: { screenshot: true, verificationScreenshot: true },
        });
    }
    async markApplied(id) {
        const application = await this.getById(id);
        await this.prisma.campaign.update({
            where: { id: application.campaignId },
            data: { totalApplicationsSent: { increment: 1 } },
        });
        // No per-candidature email here — DigestService reads `appliedAt`
        // directly off the Application table and sends a periodic summary
        // instead (see digest.service.ts), covering this manual path too.
        return this.prisma.application.update({
            where: { id },
            data: { status: 'applied', appliedAt: new Date() },
            include: { jobOffer: true },
        });
    }
    async remove(id) {
        await this.getById(id);
        const deleted = await this.prisma.application.delete({ where: { id } });
        await this.decrementCampaignStats([{ campaignId: deleted.campaignId, status: deleted.status }]);
        return deleted;
    }
    // `status`/`scope` scope this to exactly one tab (e.g. "à postuler" alone,
    // or just its history) instead of only ever offering "this one status" or
    // "everything" — both left undefined still wipes every candidature.
    async removeAll(status, scope) {
        const userId = await this.localUser.getDefaultUserId();
        const where = await this.buildStatusScopeFilter(userId, status, scope);
        const toDelete = await this.prisma.application.findMany({
            where,
            select: { campaignId: true, status: true },
        });
        const result = await this.prisma.application.deleteMany({ where });
        await this.decrementCampaignStats(toDelete);
        // No status filter at all means "wipe everything" — a deliberate fresh
        // start, so the scan/filter counters reset too, not just
        // prepared/sent. A scoped delete (one tab/status) leaves them alone:
        // offers filtered out along the way never became Application rows in
        // the first place, so a partial delete has nothing to "give back" for
        // those. Reset directly off the user's campaigns (not just whatever
        // campaignIds happened to appear in `toDelete`) so this still works
        // when the list was already empty and the stats were merely stale.
        if (!status) {
            const campaigns = await this.prisma.campaign.findMany({ where: { userId }, select: { id: true } });
            if (campaigns.length) {
                await this.prisma.campaign.updateMany({
                    where: { id: { in: campaigns.map((c) => c.id) } },
                    data: { totalOffersScanned: 0, totalOffersFiltered: 0 },
                });
            }
        }
        return { deleted: result.count };
    }
    async regenerate(id) {
        const application = await this.getById(id);
        const userId = await this.localUser.getDefaultUserId();
        const cv = await this.cvService.getCV(userId);
        const { application: updated, failures, errorMessage } = await this.prep.prepareMaterials(id, cv, application.jobOffer, userId);
        if (failures.length === 3) {
            throw new common_1.ServiceUnavailableException(`La génération IA a échoué : ${errorMessage || 'erreur inconnue'}. Vérifiez la clé DeepSeek dans Paramètres.`);
        }
        return updated;
    }
    async addManual(dto) {
        const userId = await this.localUser.getDefaultUserId();
        const campaign = await this.campaignService.getOrCreateCampaign();
        const cv = await this.cvService.getCV(userId);
        const externalId = (0, crypto_1.createHash)('sha1').update(dto.url).digest('hex');
        const jobOffer = await this.prisma.jobOffer.upsert({
            where: { source_externalId: { source: 'manual', externalId } },
            update: {
                title: dto.title,
                company: dto.company,
                location: dto.location,
                description: dto.description,
            },
            create: {
                externalId,
                source: 'manual',
                title: dto.title,
                company: dto.company,
                location: dto.location,
                description: dto.description,
                url: dto.url,
            },
        });
        const existing = await this.prisma.application.findUnique({
            where: { campaignId_jobOfferId: { campaignId: campaign.id, jobOfferId: jobOffer.id } },
            include: { jobOffer: true },
        });
        if (existing)
            return existing;
        const result = this.matching.match(cv, {
            title: jobOffer.title,
            description: jobOffer.description,
            location: jobOffer.location || '',
        }, campaign.keywords || [], campaign.seniorityKeywords || [], campaign.location);
        return this.prisma.application.create({
            data: {
                userId,
                campaignId: campaign.id,
                jobOfferId: jobOffer.id,
                jobTitle: jobOffer.title,
                company: jobOffer.company,
                location: jobOffer.location,
                sourceUrl: jobOffer.url,
                matchScore: result.score,
                matchedSkills: result.matchedSkills,
                missingSkills: result.missingSkills,
            },
            include: { jobOffer: true },
        });
    }
    async getCvData(id) {
        const application = await this.getById(id);
        const userId = await this.localUser.getDefaultUserId();
        const liveCv = await this.cvService.getCV(userId);
        if (application.adaptedCvData) {
            // adaptedCvData is a frozen AI snapshot taken when the candidature was
            // prepared — it's meant to capture offer-specific experience/project
            // adaptations, not your identity. If fullName/email/etc were blank (or
            // have since changed) at snapshot time, every candidature prepared
            // before the fix would otherwise permanently show stale contact info.
            // Always take identity fields from the live CV instead.
            const snapshot = application.adaptedCvData;
            return {
                ...snapshot,
                fullName: liveCv.fullName,
                headline: liveCv.headline,
                email: liveCv.email,
                phone: liveCv.phone,
                location: liveCv.location,
                links: liveCv.links,
            };
        }
        return liveCv;
    }
};
exports.ApplicationsService = ApplicationsService;
exports.ApplicationsService = ApplicationsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        local_user_service_1.LocalUserService,
        cv_service_1.CvService,
        matching_service_1.MatchingService,
        campaign_service_1.CampaignService,
        application_prep_service_1.ApplicationPrepService])
], ApplicationsService);
