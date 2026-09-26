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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApplicationsController = void 0;
const campaign_service_1 = require("../campaign/campaign.service");
const common_1 = require("@nestjs/common");
const applications_service_1 = require("./applications.service");
const pdf_service_1 = require("../pdf/pdf.service");
const cv_file_name_1 = require("../common/cv-file-name");
const update_status_dto_1 = require("./dto/update-status.dto");
const update_tracking_dto_1 = require("./dto/update-tracking.dto");
const add_manual_dto_1 = require("./dto/add-manual.dto");
let ApplicationsController = class ApplicationsController {
    constructor(applicationsService, pdfService, campaignService) {
        this.applicationsService = applicationsService;
        this.pdfService = pdfService;
        this.campaignService = campaignService;
    }
    async list(status, scope) {
        return this.applicationsService.list(status, scope);
    }
    async addManual(dto) {
        return this.applicationsService.addManual(dto);
    }
    async removeAll(status, scope) {
        return this.applicationsService.removeAll(status, scope);
    }
    async getById(id) {
        return this.applicationsService.getById(id);
    }
    async updateStatus(id, dto) {
        return this.applicationsService.updateStatus(id, dto.status);
    }
    async updateTracking(id, dto) {
        return this.applicationsService.updateTracking(id, dto);
    }
    async apply(id) {
        return this.applicationsService.markApplied(id);
    }
    async retryOne(id) {
        return this.campaignService.retryOne(id);
    }
    async regenerate(id) {
        return this.applicationsService.regenerate(id);
    }
    async remove(id) {
        return this.applicationsService.remove(id);
    }
    async getCv(id, res) {
        const cv = await this.applicationsService.getCvData(id);
        const pdf = await this.pdfService.generateCVPdf(cv);
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="${(0, cv_file_name_1.buildCvFileName)(cv.fullName)}"`,
            'Content-Length': pdf.length,
        });
        res.send(pdf);
    }
    async getScreenshot(id, res) {
        const screenshot = await this.applicationsService.getScreenshot(id);
        if (!screenshot)
            throw new common_1.NotFoundException('Aucune capture disponible pour cette candidature');
        res.set({
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'private, max-age=3600',
        });
        res.send(screenshot);
    }
    async getVerificationScreenshot(id, res) {
        const screenshot = await this.applicationsService.getVerificationScreenshot(id);
        if (!screenshot)
            throw new common_1.NotFoundException('Aucune capture de vérification disponible pour cette candidature');
        res.set({
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'private, max-age=3600',
        });
        res.send(screenshot);
    }
    async getCoverLetterPdf(id, res) {
        const application = await this.applicationsService.getById(id);
        const cv = await this.applicationsService.getCvData(id);
        const pdf = await this.pdfService.generateCoverLetterPdf({
            fullName: cv.fullName,
            email: cv.email,
            phone: cv.phone,
            location: cv.location,
            company: application.company,
            jobTitle: application.jobTitle,
            body: application.coverLetter || '',
        });
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'inline; filename="lettre-de-motivation.pdf"',
            'Content-Length': pdf.length,
        });
        res.send(pdf);
    }
};
exports.ApplicationsController = ApplicationsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Query)('status')),
    __param(1, (0, common_1.Query)('scope')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], ApplicationsController.prototype, "list", null);
__decorate([
    (0, common_1.Post)('manual'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [add_manual_dto_1.AddManualOfferDto]),
    __metadata("design:returntype", Promise)
], ApplicationsController.prototype, "addManual", null);
__decorate([
    (0, common_1.Delete)(),
    __param(0, (0, common_1.Query)('status')),
    __param(1, (0, common_1.Query)('scope')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], ApplicationsController.prototype, "removeAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ApplicationsController.prototype, "getById", null);
__decorate([
    (0, common_1.Patch)(':id/status'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_status_dto_1.UpdateStatusDto]),
    __metadata("design:returntype", Promise)
], ApplicationsController.prototype, "updateStatus", null);
__decorate([
    (0, common_1.Patch)(':id/tracking'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_tracking_dto_1.UpdateTrackingDto]),
    __metadata("design:returntype", Promise)
], ApplicationsController.prototype, "updateTracking", null);
__decorate([
    (0, common_1.Post)(':id/apply'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ApplicationsController.prototype, "apply", null);
__decorate([
    (0, common_1.Post)(':id/retry'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ApplicationsController.prototype, "retryOne", null);
__decorate([
    (0, common_1.Post)(':id/regen'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ApplicationsController.prototype, "regenerate", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ApplicationsController.prototype, "remove", null);
__decorate([
    (0, common_1.Get)(':id/cv'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ApplicationsController.prototype, "getCv", null);
__decorate([
    (0, common_1.Get)(':id/screenshot'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ApplicationsController.prototype, "getScreenshot", null);
__decorate([
    (0, common_1.Get)(':id/verification-screenshot'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ApplicationsController.prototype, "getVerificationScreenshot", null);
__decorate([
    (0, common_1.Get)(':id/lettre'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ApplicationsController.prototype, "getCoverLetterPdf", null);
exports.ApplicationsController = ApplicationsController = __decorate([
    (0, common_1.Controller)('candidatures'),
    __metadata("design:paramtypes", [applications_service_1.ApplicationsService,
        pdf_service_1.PdfService,
        campaign_service_1.CampaignService])
], ApplicationsController);
