import time

from fastapi import Depends

from system.backend.app.models.domain.error import Error
from system.backend.app.models.schemas.code_base_search_schema import (
    CodeBaseSearchQueryRequest,
)
from system.backend.app.repositories.error_repo import ErrorRepo
from system.backend.app.services.search_tools.embedding_service import (
    EmbeddingService,
)
from system.backend.app.services.search_tools.pinecone_service import (
    PineconeService,
)
from system.backend.app.services.search_tools.re_ranking_service import (
    RerankerService,
)


class CodeBaseSearchUsecase:
    def __init__(
        self,
        embedding_service: EmbeddingService = Depends(EmbeddingService),
        pinecone_service: PineconeService = Depends(PineconeService),
        reranker_service: RerankerService = Depends(RerankerService),
        error_repo: ErrorRepo = Depends(ErrorRepo),
    ):
        self.embedding_service = embedding_service
        self.pinecone_service = pinecone_service
        self.reranker_service = reranker_service
        self.embedding_model = "voyage-code-3"
        self.reranker_model = "rerank-2"
        self.similarity_metric = "dotproduct"
        self.dimension = 1024
        self.query_input_type = "query"
        self.index_host = (
            "dotproduct-1024-npedpix.svc.aped-4627-b74a.pinecone.io"
        )
        self.llm_model = "claude-sonnet-4-20250514"  # Or the latest Claude 3.7 Sonnet model name
        self.top_k = 20  # Number of results to retrieve from vector DB
        self.top_n = 10  # Number of results after reranking
        self.error_repo = error_repo

    async def perform_rag(self, query: str, target_directories: list[str]):
        # Step 1: Generate embeddings for the query
        query_embedding = (
            await self.embedding_service.voyageai_dense_embeddings(
                self.embedding_model,
                dimension=self.dimension,
                inputs=[query],
                input_type=self.query_input_type,
            )
        )
        query_embedding = query_embedding[0]
        # Step 2: Query Pinecone with the embeddings
        index_name = f"{self.similarity_metric}-{self.dimension}"
        index_host = self.index_host

        # Create metadata filter based on target directories if provided
        filter_conditions = {}
        if target_directories and len(target_directories) > 0:
            filter_conditions = {"directory": {"$in": target_directories}}

        vector_search_results = await self.pinecone_service.pinecone_query(
            index_host=index_host,
            top_k=self.top_k,
            vector=query_embedding,
            include_metadata=True,
            filter_dict=filter_conditions,
        )

        if not vector_search_results or not vector_search_results.get(
            "matches"
        ):
            return []

        # Step 3: Extract text passages and metadata from results
        documents = []
        doc_metadata = []
        file_paths = []
        for match in vector_search_results.get("matches", []):
            if match.get("metadata") and match.get("metadata").get("text"):
                file_paths.append(
                    match.get("metadata", {}).get("file_path", "unknown")
                )
                documents.append(match["metadata"]["text"])
                doc_metadata.append(
                    {
                        "score": match.get("score", 0),
                        "file_path": match.get("metadata", {}).get(
                            "file_path", "unknown"
                        ),
                        "start_line": match.get("metadata", {}).get(
                            "start_line", "unknown"
                        ),
                        "end_line": match.get("metadata", {}).get(
                            "end_line", "unknown"
                        ),
                        "file_name": match.get("metadata", {}).get(
                            "file_name", "unknown"
                        ),
                    }
                )

        if not documents:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message="No valid documents found in vector search results",
                )
            )
            return []

        reranked_results = await self.reranker_service.voyage_rerank(
            self.reranker_model, query, documents, self.top_n
        )

        # Step 5: Combine reranked results with metadata
        final_results = []
        for result in reranked_results.get("data", []):
            index = result.get("index")
            if index is not None and 0 <= index < len(doc_metadata):
                final_results.append(
                    {
                        "text": documents[index],
                        "relevance_score": result.get("relevance_score", 0),
                        "metadata": doc_metadata[index],
                    }
                )

        full_final_results = final_results
        return full_final_results

    async def process_query(self, request: CodeBaseSearchQueryRequest):
        start_time = time.time()
        query = request.query
        target_directories = request.target_directories

        retrieved_docs = await self.perform_rag(query, target_directories)

        # Step 3: Format and return the final response
        end_time = time.time()
        processing_time = end_time - start_time

        return retrieved_docs
