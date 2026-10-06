import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { LazyPage } from './lazy';
import { WORK, LocalWorker } from './tokens';
@NgModule({
	imports: [RouterModule.forChild([{ path: 'module-child', component: LazyPage }])],
	providers: [{ provide: WORK, useClass: LocalWorker }],
})
export class LazyModule {}
