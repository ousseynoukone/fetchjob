import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { LocalUserService } from '../common/local-user.service';
import { EmailService } from '../email/email.service';
import { normalizeLabel } from '../auto-apply/appliers/form-fields';
import type { DetectedField } from '../auto-apply/appliers/form-fields';

export interface UnknownFieldEntry extends DetectedField {
  platform: string;
  sourceUrl: string;
}

@Injectable()
export class CustomQuestionsService {
  private readonly logger = new Logger(CustomQuestionsService.name);

  constructor(
    private prisma: PrismaService,
    private localUser: LocalUserService,
    private email: EmailService,
  ) {}

  async list() {
    const userId = await this.localUser.getDefaultUserId();
    return this.prisma.customQuestion.findMany({
      where: { userId },
      orderBy: [{ answer: 'asc' }, { lastSeenAt: 'desc' }],
    });
  }

  async setAnswer(id: string, answer: string) {
    return this.prisma.customQuestion.update({
      where: { id },
      data: { answer, answeredAt: new Date() },
    });
  }

  async clearAnswer(id: string) {
    return this.prisma.customQuestion.update({
      where: { id },
      data: { answer: null, answeredAt: null },
    });
  }

  // Loaded once per auto-apply run and handed to every applier via
  // ApplyContext — a normalized-label -> answer lookup so a question
  // answered once is filled automatically everywhere it recurs.
  async getKnownAnswers(userId: string): Promise<Map<string, string>> {
    const rows = await this.prisma.customQuestion.findMany({
      where: { userId, answer: { not: null } },
    });
    return new Map(rows.map((r) => [r.questionTextNormalized, r.answer as string]));
  }

  // Called by AutoApplyService when an applier couldn't get past a
  // validation error — records each still-unanswered field so it shows up
  // in the "Questions" page, and emails a summary of genuinely new ones
  // (repeat sightings of an already-known-but-unanswered question don't
  // spam another email, just bump the occurrence count).
  async recordUnknown(userId: string, entries: UnknownFieldEntry[]): Promise<void> {
    if (!entries.length) return;

    const newlyCaptured: { questionText: string; platform: string }[] = [];

    for (const entry of entries) {
      const questionTextNormalized = normalizeLabel(entry.questionText);
      const existing = await this.prisma.customQuestion.findUnique({
        where: { userId_questionTextNormalized: { userId, questionTextNormalized } },
      });

      if (existing) {
        await this.prisma.customQuestion.update({
          where: { id: existing.id },
          data: { occurrenceCount: { increment: 1 }, lastSeenAt: new Date(), lastSourceUrl: entry.sourceUrl },
        });
      } else {
        await this.prisma.customQuestion.create({
          data: {
            userId,
            platform: entry.platform,
            questionText: entry.questionText,
            questionTextNormalized,
            fieldType: entry.fieldType,
            options: entry.options,
            lastSourceUrl: entry.sourceUrl,
          },
        });
        newlyCaptured.push({ questionText: entry.questionText, platform: entry.platform });
      }
    }

    if (newlyCaptured.length) {
      const items = newlyCaptured.map((q) => `<li>[${q.platform}] ${q.questionText}</li>`).join('');
      await this.email.send(
        `${newlyCaptured.length} nouvelle(s) question(s) à répondre pour l'auto-apply`,
        `<p>De nouvelles questions personnalisées ont bloqué l'auto-apply :</p><ul>${items}</ul>` +
          `<p>Répondez-y une fois dans FindUrJob (page Questions) pour qu'elles soient remplies automatiquement la prochaine fois.</p>`,
      );
    }
  }
}
