/**
 * DTOs do painel sob o ValidationPipe global.
 *
 * Regressão coberta: o frontend envia o token do painel no cabeçalho
 * `x-panel-token` (e a chave de setup no `x-aga-setup-key`), com o corpo
 * contendo só os campos de negócio — `{}` nas rotas que não têm payload.
 *
 * Enquanto `panelToken` era OBRIGATÓRIO no corpo, o `forbidNonWhitelisted` do
 * ValidationPipe recusava essas chamadas com 400 antes de o handler rodar. O
 * sintoma era o `POST /v1/db-admin/auth/session` falhando com corpo `{}` e
 * content-length 2, mesmo com um token válido no cabeçalho — ou seja, o login
 * funcionava e a sessão logo em seguida não.
 *
 * O guard continua sendo quem exige o token: sem ele no corpo e sem ele no
 * cabeçalho, `readPanelToken` devolve `undefined` e o guard responde 401.
 */

import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateAppUserDto, PanelLoginDto, PanelTokenDto } from '../src/dbadmin/dto';

/** O mesmo pipe configurado em `src/main.ts`. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

const asBody = (metatype: unknown, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: metatype as never });

describe('DTOs do painel aceitam o token vindo só do cabeçalho', () => {
  it('corpo {} é aceito nas rotas autenticadas por cabeçalho', async () => {
    // Payload exato do auth/session que devolvia 400 (content-length: 2 = "{}").
    await expect(asBody(PanelTokenDto, {})).resolves.toBeDefined();
  });

  it('createUser aceita os campos de negócio sem panelToken', async () => {
    await expect(
      asBody(CreateAppUserDto, {
        name: 'Fulano', email: 'f@aga.local', password: 'senha12345', role: 'CLIENT',
      }),
    ).resolves.toBeDefined();
  });

  it('o login continua exigindo as credenciais de verdade', async () => {
    // A correção não pode ter afrouxado o login: corpo vazio segue sendo 400.
    await expect(asBody(PanelLoginDto, {})).rejects.toThrow(BadRequestException);
  });

  it('campo desconhecido continua sendo rejeitado', async () => {
    await expect(asBody(PanelTokenDto, { panelToken: 'x'.repeat(20), lixo: 1 })).rejects.toThrow(BadRequestException);
  });

  it('panelToken no corpo, quando enviado, ainda é validado', async () => {
    await expect(asBody(PanelTokenDto, { panelToken: 'curto' })).rejects.toThrow(BadRequestException);
  });
});
